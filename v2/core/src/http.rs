//! The HTTP surface the engine depends on.
//!
//! Deliberately a trait rather than a concrete client. The core stays free of
//! any networking dependency, which means the whole engine — including source
//! resolution — is testable without a network, using recorded responses
//! (V2-PLAN.md 8, "contract tests"). The real `reqwest`-backed implementation
//! lives in the application layer.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::{Error, Result};

/// Hosts the engine is willing to talk to.
///
/// Redirects are followed only within this set, so a compromised or hijacked
/// release URL cannot bounce a download to an arbitrary host.
pub const ALLOWED_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
    "gitlab.com",
];

/// True if `url` is https and points at a host we allow.
pub fn is_allowed_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or_default()
        .split('@')
        .next_back()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default();
    ALLOWED_HOSTS.contains(&host)
}

#[derive(Debug, Clone, Default)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, String>,
}

impl Response {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::from_slice(&self.body)?)
    }
}

/// What the engine needs from the network.
#[async_trait::async_trait]
pub trait HttpClient: Send + Sync {
    /// Fetch a URL. Implementations must reject non-allowed hosts, enforce a
    /// timeout, and cap the response body.
    async fn get(&self, url: &str, headers: &[(String, String)]) -> Result<Response>;

    /// Stream a URL to `dest`. Implementations must apply the same host and
    /// size limits, and remove a partial file on failure.
    async fn download(&self, url: &str, dest: &Path) -> Result<u64>;
}

/// Build the request headers for a forge API call.
pub fn api_headers(token: Option<&str>, etag: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![
        ("User-Agent".to_string(), user_agent()),
        ("Accept".to_string(), "application/json".to_string()),
    ];
    if let Some(token) = token {
        // A token lifts the anonymous 60 requests/hour limit to 5,000, which is
        // what lets V2 drop V1's HTML scraping entirely (D6, V2-PLAN.md D-d).
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    if let Some(etag) = etag {
        // A 304 costs no rate-limit quota at all.
        headers.push(("If-None-Match".to_string(), etag.to_string()));
    }
    headers
}

pub fn user_agent() -> String {
    format!("BrowniesAddonManager/{}", env!("CARGO_PKG_VERSION"))
}

/// Guard used by implementations before issuing a request.
pub fn ensure_allowed(url: &str) -> Result<()> {
    if is_allowed_url(url) {
        Ok(())
    } else {
        Err(Error::Network(format!(
            "refusing to request {url}: not an allowed https host"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_known_forge_hosts() {
        assert!(is_allowed_url("https://api.github.com/repos/o/r"));
        assert!(is_allowed_url("https://codeload.github.com/o/r/zip/v1"));
        assert!(is_allowed_url("https://gitlab.com/api/v4/projects/1"));
    }

    #[test]
    fn rejects_plain_http() {
        assert!(!is_allowed_url("http://github.com/o/r"));
    }

    #[test]
    fn rejects_unknown_hosts() {
        assert!(!is_allowed_url("https://evil.example.com/payload.zip"));
    }

    #[test]
    fn rejects_userinfo_host_spoofing() {
        // `https://api.github.com@evil.com/` actually resolves to evil.com.
        assert!(!is_allowed_url("https://api.github.com@evil.com/x"));
    }

    #[test]
    fn rejects_subdomain_suffix_spoofing() {
        assert!(!is_allowed_url("https://github.com.evil.com/o/r"));
        assert!(!is_allowed_url("https://notgithub.com/o/r"));
    }

    #[test]
    fn ignores_ports_when_matching_hosts() {
        assert!(is_allowed_url("https://github.com:443/o/r"));
    }

    #[test]
    fn api_headers_include_auth_only_when_a_token_is_present() {
        let anonymous = api_headers(None, None);
        assert!(!anonymous.iter().any(|(k, _)| k == "Authorization"));

        let authorised = api_headers(Some("ghp_x"), None);
        assert!(authorised
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer ghp_x"));
    }

    #[test]
    fn api_headers_send_the_etag_for_conditional_requests() {
        let headers = api_headers(None, Some("W/\"abc\""));
        assert!(headers
            .iter()
            .any(|(k, v)| k == "If-None-Match" && v == "W/\"abc\""));
    }

    #[test]
    fn ensure_allowed_rejects_bad_hosts() {
        assert!(ensure_allowed("https://api.github.com/x").is_ok());
        assert!(ensure_allowed("https://evil.example.com/x").is_err());
    }

    #[test]
    fn response_headers_are_case_insensitive() {
        let mut response = Response::default();
        response
            .headers
            .insert("ETag".to_string(), "abc".to_string());
        assert_eq!(response.header("etag"), Some("abc"));
    }
}
