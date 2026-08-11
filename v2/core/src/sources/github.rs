//! GitHub release and branch resolution.
//!
//! V1 fell back to scraping GitHub's HTML with regexes when the API rate-limit
//! bit (V2-PLAN.md D-d). That existed only because 60 anonymous requests an
//! hour is not enough for a user with thirty addons. With an optional token
//! and conditional requests, none of it is needed — so none of it is here.

use crate::error::{Error, Result};
use crate::http::{api_headers, HttpClient};
use crate::model::Channel;
use crate::version::Ref;

use super::{choose_zip_asset, Resolved};

pub async fn resolve(
    client: &dyn HttpClient,
    owner: &str,
    repo: &str,
    channel: Channel,
    token: Option<&str>,
) -> Result<Resolved> {
    match channel {
        Channel::Release => latest_release(client, owner, repo, token).await,
        Channel::Source => default_branch_head(client, owner, repo, token).await,
    }
}

async fn latest_release(
    client: &dyn HttpClient,
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<Resolved> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let response = client.get(&url, &api_headers(token, None)).await?;

    if response.status == 404 {
        // No releases. We do NOT silently fall back to the branch head: that
        // would install a different kind of artifact than the user asked for,
        // which is exactly the confusion the Ref model exists to prevent.
        return Err(Error::NoResolvableRef(format!(
            "{owner}/{repo} has no published releases — switch this addon to the source channel"
        )));
    }
    if !response.is_success() {
        return Err(Error::HttpStatus {
            status: response.status,
            url,
        });
    }

    let json = response.json()?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::NoResolvableRef(format!("{owner}/{repo}: release has no tag")))?
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let assets: Vec<(String, String)> = json
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|asset| {
                    let name = asset.get("name")?.as_str()?.to_string();
                    let url = asset.get("browser_download_url")?.as_str()?.to_string();
                    Some((name, url))
                })
                .collect()
        })
        .unwrap_or_default();

    // A release with no usable zip asset still has a source archive for the
    // tag, which is what most WoW addons actually ship.
    let download_url = choose_zip_asset(&assets)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!("https://codeload.github.com/{owner}/{repo}/zip/refs/tags/{tag}")
        });

    Ok(Resolved {
        r#ref: Ref::Release { tag, published_at },
        download_url,
        etag: response.header("etag").map(str::to_string),
    })
}

async fn default_branch_head(
    client: &dyn HttpClient,
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<Resolved> {
    let repo_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let repo_response = client.get(&repo_url, &api_headers(token, None)).await?;
    if !repo_response.is_success() {
        return Err(Error::HttpStatus {
            status: repo_response.status,
            url: repo_url,
        });
    }
    let branch = repo_response
        .json()?
        .get("default_branch")
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();

    let commit_url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{branch}");
    let commit_response = client.get(&commit_url, &api_headers(token, None)).await?;
    if !commit_response.is_success() {
        return Err(Error::HttpStatus {
            status: commit_response.status,
            url: commit_url,
        });
    }
    let commit_json = commit_response.json()?;
    let sha = commit_json
        .get("sha")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::NoResolvableRef(format!("{owner}/{repo}: no commit sha")))?
        .to_string();
    let committed_at = commit_json
        .pointer("/commit/author/date")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok(Resolved {
        download_url: format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"),
        r#ref: Ref::Branch {
            branch,
            sha,
            committed_at,
        },
        etag: commit_response.header("etag").map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeHttp;

    fn release_body(tag: &str, assets: &str) -> String {
        format!(
            r#"{{"tag_name":"{tag}","published_at":"2026-01-01T00:00:00Z","assets":[{assets}]}}"#
        )
    }

    #[tokio::test]
    async fn resolves_a_release_with_a_zip_asset() {
        let client = FakeHttp::new().json(
            "https://api.github.com/repos/o/r/releases/latest",
            &release_body(
                "v1.2.3",
                r#"{"name":"MyAddon-1.2.3.zip","browser_download_url":"https://github.com/o/r/releases/download/v1.2.3/MyAddon-1.2.3.zip"}"#,
            ),
        );

        let resolved = resolve(&client, "o", "r", Channel::Release, None)
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            resolved.r#ref,
            Ref::Release {
                tag: "v1.2.3".into(),
                published_at: Some("2026-01-01T00:00:00Z".into())
            }
        );
        assert!(resolved.download_url.ends_with("MyAddon-1.2.3.zip"));
    }

    #[tokio::test]
    async fn falls_back_to_the_tag_source_archive_when_there_is_no_zip_asset() {
        let client = FakeHttp::new().json(
            "https://api.github.com/repos/o/r/releases/latest",
            &release_body("v2.0.0", ""),
        );

        let resolved = resolve(&client, "o", "r", Channel::Release, None)
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            resolved.download_url,
            "https://codeload.github.com/o/r/zip/refs/tags/v2.0.0"
        );
    }

    /// The important behaviour: no silent channel switching (V2-PLAN.md 5.4).
    #[tokio::test]
    async fn a_repo_with_no_releases_errors_rather_than_switching_channel() {
        let client = FakeHttp::new().status(
            "https://api.github.com/repos/o/r/releases/latest",
            404,
            r#"{"message":"Not Found"}"#,
        );

        let result = resolve(&client, "o", "r", Channel::Release, None).await;
        assert!(matches!(result, Err(Error::NoResolvableRef(_))));
    }

    #[tokio::test]
    async fn surfaces_rate_limiting_instead_of_scraping_html() {
        let client = FakeHttp::new().status(
            "https://api.github.com/repos/o/r/releases/latest",
            403,
            r#"{"message":"rate limit exceeded"}"#,
        );

        let result = resolve(&client, "o", "r", Channel::Release, None).await;
        assert!(matches!(result, Err(Error::HttpStatus { status: 403, .. })));
    }

    #[tokio::test]
    async fn resolves_the_default_branch_head_for_the_source_channel() {
        let client = FakeHttp::new()
            .json(
                "https://api.github.com/repos/o/r",
                r#"{"default_branch":"master"}"#,
            )
            .json(
                "https://api.github.com/repos/o/r/commits/master",
                r#"{"sha":"abc1234def","commit":{"author":{"date":"2026-02-02T00:00:00Z"}}}"#,
            );

        let resolved = resolve(&client, "o", "r", Channel::Source, None)
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            resolved.r#ref,
            Ref::Branch {
                branch: "master".into(),
                sha: "abc1234def".into(),
                committed_at: Some("2026-02-02T00:00:00Z".into())
            }
        );
        assert_eq!(
            resolved.download_url,
            "https://codeload.github.com/o/r/zip/refs/heads/master"
        );
    }

    #[tokio::test]
    async fn sends_the_token_when_one_is_configured() {
        let client = FakeHttp::new().json(
            "https://api.github.com/repos/o/r/releases/latest",
            &release_body("v1.0.0", ""),
        );

        let _ = resolve(&client, "o", "r", Channel::Release, Some("ghp_secret")).await;

        assert!(
            client.saw_header("Authorization", "Bearer ghp_secret"),
            "a configured token must be sent"
        );
    }

    #[tokio::test]
    async fn captures_the_etag_for_the_next_conditional_request() {
        let client = FakeHttp::new()
            .json(
                "https://api.github.com/repos/o/r/releases/latest",
                &release_body("v1.0.0", ""),
            )
            .with_header("ETag", "W/\"deadbeef\"");

        let resolved = resolve(&client, "o", "r", Channel::Release, None)
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(resolved.etag.as_deref(), Some("W/\"deadbeef\""));
    }
}
