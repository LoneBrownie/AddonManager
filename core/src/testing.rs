//! Test doubles.
//!
//! Shipped as part of the crate rather than hidden behind `#[cfg(test)]` so the
//! application layer can use the same fake when testing its own commands. No
//! test in this workspace touches the network.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use crate::error::{Error, Result};
use crate::http::{HttpClient, Response};

/// A recorded request: the URL, and the headers it carried.
type RecordedRequest = (String, Vec<(String, String)>);

/// An [`HttpClient`] that serves canned responses and records what it was
/// asked for.
#[derive(Debug, Default)]
pub struct FakeHttp {
    routes: Mutex<BTreeMap<String, Response>>,
    downloads: Mutex<BTreeMap<String, Vec<u8>>>,
    last_route: Mutex<Option<String>>,
    requests: Mutex<Vec<RecordedRequest>>,
}

impl FakeHttp {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a 200 JSON response.
    pub fn json(self, url: &str, body: &str) -> Self {
        self.status(url, 200, body)
    }

    /// Register a response with an explicit status.
    pub fn status(self, url: &str, status: u16, body: &str) -> Self {
        if let Ok(mut routes) = self.routes.lock() {
            routes.insert(
                url.to_string(),
                Response {
                    status,
                    body: body.as_bytes().to_vec(),
                    headers: BTreeMap::new(),
                },
            );
        }
        if let Ok(mut last) = self.last_route.lock() {
            *last = Some(url.to_string());
        }
        self
    }

    /// Attach a header to the most recently registered response.
    pub fn with_header(self, name: &str, value: &str) -> Self {
        let target = self.last_route.lock().ok().and_then(|l| l.clone());
        if let (Some(url), Ok(mut routes)) = (target, self.routes.lock()) {
            if let Some(response) = routes.get_mut(&url) {
                response.headers.insert(name.to_string(), value.to_string());
            }
        }
        self
    }

    /// Register bytes to be served by [`HttpClient::download`].
    pub fn file(self, url: &str, bytes: Vec<u8>) -> Self {
        if let Ok(mut downloads) = self.downloads.lock() {
            downloads.insert(url.to_string(), bytes);
        }
        self
    }

    /// True if any request carried this exact header.
    pub fn saw_header(&self, name: &str, value: &str) -> bool {
        let Ok(requests) = self.requests.lock() else {
            return false;
        };
        requests.iter().any(|(_, headers)| {
            headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value)
        })
    }

    /// Every URL requested, in order.
    pub fn requested_urls(&self) -> Vec<String> {
        self.requests
            .lock()
            .map(|r| r.iter().map(|(url, _)| url.clone()).collect())
            .unwrap_or_default()
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().map(|r| r.len()).unwrap_or(0)
    }
}

#[async_trait::async_trait]
impl HttpClient for FakeHttp {
    async fn get(&self, url: &str, headers: &[(String, String)]) -> Result<Response> {
        if let Ok(mut requests) = self.requests.lock() {
            requests.push((url.to_string(), headers.to_vec()));
        }
        let routes = self
            .routes
            .lock()
            .map_err(|_| Error::Network("fake http lock poisoned".into()))?;
        routes
            .get(url)
            .cloned()
            .ok_or_else(|| Error::Network(format!("no canned response registered for {url}")))
    }

    async fn download(&self, url: &str, dest: &Path) -> Result<u64> {
        if let Ok(mut requests) = self.requests.lock() {
            requests.push((url.to_string(), Vec::new()));
        }
        let downloads = self
            .downloads
            .lock()
            .map_err(|_| Error::Network("fake http lock poisoned".into()))?;
        let bytes = downloads
            .get(url)
            .ok_or_else(|| Error::Network(format!("no canned download registered for {url}")))?;

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
        std::fs::write(dest, bytes).map_err(|e| Error::io(dest, e))?;
        Ok(bytes.len() as u64)
    }
}

/// Build an in-memory zip from `(path, contents)` pairs.
///
/// Used to stand in for a released addon archive without a network.
pub fn zip_from(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::{Cursor, Write as _};

    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default();
        for (name, contents) in entries {
            if writer.start_file(*name, options).is_err() {
                break;
            }
            if writer.write_all(contents).is_err() {
                break;
            }
        }
        let _ = writer.finish();
    }
    buffer.into_inner()
}

/// A minimal but valid addon archive containing a single folder.
pub fn addon_zip(folder: &str, interface: u32, version: &str) -> Vec<u8> {
    let toc = format!(
        "## Interface: {interface}\n## Title: {folder}\n## Version: {version}\n\nCore.lua\n"
    );
    let toc_path = format!("{folder}/{folder}.toc");
    let lua_path = format!("{folder}/Core.lua");
    zip_from(&[
        (toc_path.as_str(), toc.as_bytes()),
        (lua_path.as_str(), b"-- code\n"),
    ])
}

/// Create a plausible WoW directory tree under `root`.
pub fn fake_wow_dir(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root.join("Data"))?;
    std::fs::create_dir_all(root.join("Interface").join("AddOns"))?;
    std::fs::write(root.join("Wow.exe"), b"MZ")?;
    Ok(())
}
