//! Resolving "what should I download?" for a source and channel.

pub mod github;
pub mod gitlab;

use crate::error::{Error, Result};
use crate::http::HttpClient;
use crate::model::{Channel, Source};
use crate::version::Ref;

/// A resolved artifact: what it is, and where to get it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub r#ref: Ref,
    pub download_url: String,
    /// Returned by the forge so the next check can be conditional.
    pub etag: Option<String>,
}

/// Parse a repository URL into a [`Source`].
///
/// Accepts the shapes users actually paste: with or without `https://`, with a
/// trailing `.git`, `/tree/main`, a trailing slash, or surrounding whitespace.
pub fn parse_repo_url(input: &str) -> Result<Source> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(Error::UnsupportedRepoUrl(input.to_string()));
    }

    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let without_www = without_scheme
        .strip_prefix("www.")
        .unwrap_or(without_scheme);

    let mut parts = without_www.split('/').filter(|p| !p.is_empty());
    let host = parts.next().unwrap_or_default().to_ascii_lowercase();
    let owner = parts.next().unwrap_or_default().to_string();
    let repo_raw = parts.next().unwrap_or_default();

    let repo = repo_raw
        .strip_suffix(".git")
        .unwrap_or(repo_raw)
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();

    if owner.is_empty() || repo.is_empty() {
        return Err(Error::UnsupportedRepoUrl(input.to_string()));
    }

    match host.as_str() {
        "github.com" => Ok(Source::Github { owner, repo }),
        "gitlab.com" => Ok(Source::Gitlab { owner, repo }),
        _ => Err(Error::UnsupportedRepoUrl(input.to_string())),
    }
}

/// Resolve the artifact a source/channel pair currently points at.
pub async fn resolve(
    client: &dyn HttpClient,
    source: &Source,
    channel: Channel,
    token: Option<&str>,
) -> Result<Resolved> {
    match source {
        Source::Github { owner, repo } => {
            github::resolve(client, owner, repo, channel, token).await
        }
        // The stored token is a GitHub one, so it is not offered here. See
        // `gitlab`: forwarding it made gitlab.com refuse the request outright.
        Source::Gitlab { owner, repo } => gitlab::resolve(client, owner, repo, channel).await,
        Source::Direct { url } => Ok(Resolved {
            r#ref: Ref::Direct {
                url: url.clone(),
                etag: None,
                last_modified: None,
            },
            download_url: url.clone(),
            etag: None,
        }),
    }
}

/// Pick the release asset to download.
///
/// Prefers a `.zip` that is not obviously a source archive or a checksum file,
/// then any `.zip`, and leaves the caller to fall back to the source tarball.
pub(crate) fn choose_zip_asset(names_and_urls: &[(String, String)]) -> Option<&str> {
    let is_zip = |name: &str| name.to_ascii_lowercase().ends_with(".zip");
    let is_noise = |name: &str| {
        let lower = name.to_ascii_lowercase();
        lower.contains("source") || lower.contains("symbols") || lower.ends_with(".sha256.zip")
    };

    names_and_urls
        .iter()
        .find(|(name, _)| is_zip(name) && !is_noise(name))
        .or_else(|| names_and_urls.iter().find(|(name, _)| is_zip(name)))
        .map(|(_, url)| url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_github_urls() {
        assert_eq!(
            parse_repo_url("https://github.com/LoneBrownie/AddonManager")
                .unwrap_or(Source::Direct { url: String::new() }),
            Source::Github {
                owner: "LoneBrownie".into(),
                repo: "AddonManager".into()
            }
        );
    }

    #[test]
    fn tolerates_the_shapes_users_actually_paste() {
        let expected = Source::Github {
            owner: "o".into(),
            repo: "r".into(),
        };
        for input in [
            "https://github.com/o/r",
            "http://github.com/o/r",
            "github.com/o/r",
            "https://www.github.com/o/r",
            "https://github.com/o/r/",
            "https://github.com/o/r.git",
            "https://github.com/o/r/tree/main",
            "  https://github.com/o/r  ",
            "https://github.com/o/r?tab=readme",
        ] {
            assert_eq!(
                parse_repo_url(input).unwrap_or(Source::Direct { url: String::new() }),
                expected,
                "failed for {input:?}"
            );
        }
    }

    #[test]
    fn parses_gitlab_urls() {
        assert_eq!(
            parse_repo_url("https://gitlab.com/Tsoukie/classicapi")
                .unwrap_or(Source::Direct { url: String::new() }),
            Source::Gitlab {
                owner: "Tsoukie".into(),
                repo: "classicapi".into()
            }
        );
    }

    #[test]
    fn rejects_unsupported_hosts_and_incomplete_paths() {
        for bad in [
            "https://bitbucket.org/o/r",
            "https://github.com/o",
            "https://github.com/",
            "not a url",
            "",
        ] {
            assert!(parse_repo_url(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn prefers_a_real_zip_over_a_source_archive() {
        let assets = vec![
            ("Source code.zip".to_string(), "u1".to_string()),
            ("MyAddon-1.0.zip".to_string(), "u2".to_string()),
        ];
        assert_eq!(choose_zip_asset(&assets), Some("u2"));
    }

    #[test]
    fn falls_back_to_any_zip() {
        let assets = vec![("Source code.zip".to_string(), "u1".to_string())];
        assert_eq!(choose_zip_asset(&assets), Some("u1"));
    }

    #[test]
    fn ignores_non_zip_assets() {
        let assets = vec![
            ("MyAddon.tar.gz".to_string(), "u1".to_string()),
            ("checksums.txt".to_string(), "u2".to_string()),
        ];
        assert_eq!(choose_zip_asset(&assets), None);
    }
}
