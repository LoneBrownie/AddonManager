//! The real [`HttpClient`], backed by `reqwest`.
//!
//! Kept out of `bam-core` on purpose: the engine depends only on the trait, so
//! its whole test suite runs without a network (V2-PLAN.md 8). This crate is
//! where the actual sockets live, and where the limits the trait's docs promise
//! are enforced.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::path::Path;
use std::time::Duration;

use bam_core::error::{Error, Result};
use bam_core::http::{ensure_allowed, is_allowed_url, user_agent, HttpClient, Response};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

/// Ceilings applied to every request.
#[derive(Debug, Clone, Copy)]
pub struct NetLimits {
    /// Whole-request timeout.
    pub timeout: Duration,
    /// Time allowed to establish a connection.
    pub connect_timeout: Duration,
    /// Largest API response body we will buffer.
    pub max_response_bytes: u64,
    /// Largest archive we will write to disk.
    pub max_download_bytes: u64,
    pub max_redirects: usize,
}

impl Default for NetLimits {
    fn default() -> Self {
        NetLimits {
            timeout: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(15),
            max_response_bytes: 8 * 1024 * 1024,
            max_download_bytes: 512 * 1024 * 1024,
            max_redirects: 5,
        }
    }
}

pub struct ReqwestClient {
    inner: reqwest::Client,
    limits: NetLimits,
}

impl std::fmt::Debug for ReqwestClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestClient")
            .field("limits", &self.limits)
            .finish()
    }
}

impl ReqwestClient {
    pub fn new() -> Result<Self> {
        Self::with_limits(NetLimits::default())
    }

    pub fn with_limits(limits: NetLimits) -> Result<Self> {
        let max_redirects = limits.max_redirects;

        // Redirects are followed only within the allowlist. A release URL that
        // has been hijacked cannot bounce the download to an arbitrary host.
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= max_redirects {
                return attempt.error("too many redirects");
            }
            if is_allowed_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });

        let inner = reqwest::Client::builder()
            .user_agent(user_agent())
            .timeout(limits.timeout)
            .connect_timeout(limits.connect_timeout)
            .redirect(policy)
            .https_only(true)
            .build()
            .map_err(|e| Error::Network(e.to_string()))?;

        Ok(ReqwestClient { inner, limits })
    }
}

#[async_trait::async_trait]
impl HttpClient for ReqwestClient {
    async fn get(&self, url: &str, headers: &[(String, String)]) -> Result<Response> {
        ensure_allowed(url)?;

        let mut request = self.inner.get(url);
        for (name, value) in headers {
            request = request.header(name.as_str(), value.as_str());
        }

        let response = request
            .send()
            .await
            .map_err(|e| Error::Network(format!("{url}: {e}")))?;

        let status = response.status().as_u16();
        let mut collected = std::collections::BTreeMap::new();
        for (name, value) in response.headers() {
            if let Ok(text) = value.to_str() {
                collected.insert(name.as_str().to_string(), text.to_string());
            }
        }

        // Read with a cap rather than trusting Content-Length, which a hostile
        // server is free to lie about.
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::Network(format!("{url}: {e}")))?;
            if body.len() as u64 + chunk.len() as u64 > self.limits.max_response_bytes {
                return Err(Error::Network(format!(
                    "{url}: response exceeds {} bytes",
                    self.limits.max_response_bytes
                )));
            }
            body.extend_from_slice(&chunk);
        }

        Ok(Response {
            status,
            body,
            headers: collected,
        })
    }

    async fn download(&self, url: &str, dest: &Path) -> Result<u64> {
        ensure_allowed(url)?;

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| Error::io(parent, e))?;
        }

        let response = self
            .inner
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Network(format!("{url}: {e}")))?;

        if !response.status().is_success() {
            return Err(Error::HttpStatus {
                status: response.status().as_u16(),
                url: url.to_string(),
            });
        }

        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| Error::io(dest, e))?;
        let mut written: u64 = 0;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(e) => return Err(cleanup(dest, Error::Network(format!("{url}: {e}"))).await),
            };

            written = written.saturating_add(chunk.len() as u64);
            if written > self.limits.max_download_bytes {
                let error = Error::Network(format!(
                    "{url}: download exceeds {} bytes",
                    self.limits.max_download_bytes
                ));
                return Err(cleanup(dest, error).await);
            }

            if let Err(e) = file.write_all(&chunk).await {
                return Err(cleanup(dest, Error::io(dest, e)).await);
            }
        }

        if let Err(e) = file.flush().await {
            return Err(cleanup(dest, Error::io(dest, e)).await);
        }

        Ok(written)
    }
}

/// Remove a partial download before returning the error that caused it.
///
/// A truncated zip left on disk would otherwise be extracted on the next
/// attempt and fail in a much more confusing place.
async fn cleanup(dest: &Path, error: Error) -> Error {
    let _ = tokio::fs::remove_file(dest).await;
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_with_default_limits() {
        assert!(ReqwestClient::new().is_ok());
    }

    #[tokio::test]
    async fn refuses_a_host_outside_the_allowlist_without_making_a_request() {
        let client = ReqwestClient::new().expect("client");
        let result = client.get("https://evil.example.com/x", &[]).await;
        assert!(matches!(result, Err(Error::Network(_))));
    }

    #[tokio::test]
    async fn refuses_plain_http() {
        let client = ReqwestClient::new().expect("client");
        assert!(client.get("http://github.com/o/r", &[]).await.is_err());
    }

    #[tokio::test]
    async fn refuses_to_download_from_a_disallowed_host() {
        let client = ReqwestClient::new().expect("client");
        let tmp = tempfile::tempdir().expect("tempdir");
        let dest = tmp.path().join("out.zip");

        let result = client
            .download("https://evil.example.com/a.zip", &dest)
            .await;

        assert!(result.is_err());
        assert!(!dest.exists(), "nothing may be written for a refused host");
    }
}
