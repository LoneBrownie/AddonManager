//! GitLab release and branch resolution.
//!
//! Most of the curated 3.3.5a list lives on GitLab, so this is not a
//! second-class path — it carries as much weight as GitHub.
//!
//! **No token is sent here, ever.** The one this app stores is a GitHub token,
//! and gitlab.com answers `401 Unauthorized` to a bearer token it does not
//! recognise — so forwarding it did not merely fail to help, it broke every
//! GitLab addon for anyone who had configured one. Sending a credential to a
//! service it was not issued for is not something to do by accident either.
//!
//! Nothing is lost by going anonymous: gitlab.com allows 500 unauthenticated
//! API requests a *minute* per IP, where GitHub allows 60 an *hour*. The rate
//! limit that makes a GitHub token worth having has no equivalent here.

use crate::error::{Error, Result};
use crate::http::{api_headers, HttpClient};
use crate::model::Channel;
use crate::version::Ref;

use super::{choose_zip_asset, Resolved};

/// GitLab addresses projects by URL-encoded `owner/repo`.
fn project_id(owner: &str, repo: &str) -> String {
    format!("{owner}%2F{repo}")
}

pub async fn resolve(
    client: &dyn HttpClient,
    owner: &str,
    repo: &str,
    channel: Channel,
) -> Result<Resolved> {
    match channel {
        Channel::Release => latest_release(client, owner, repo).await,
        Channel::Source => default_branch_head(client, owner, repo).await,
    }
}

async fn latest_release(client: &dyn HttpClient, owner: &str, repo: &str) -> Result<Resolved> {
    let id = project_id(owner, repo);
    let url = format!("https://gitlab.com/api/v4/projects/{id}/releases");
    let response = client.get(&url, &api_headers(None, None)).await?;

    if !response.is_success() {
        return Err(Error::HttpStatus {
            status: response.status,
            url,
        });
    }

    let json = response.json()?;
    let latest = json
        .as_array()
        .and_then(|releases| releases.first())
        .ok_or_else(|| {
            Error::NoResolvableRef(format!(
                "{owner}/{repo} has no published releases — switch this addon to the source channel"
            ))
        })?;

    let tag = latest
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::NoResolvableRef(format!("{owner}/{repo}: release has no tag")))?
        .to_string();
    let published_at = latest
        .get("released_at")
        .or_else(|| latest.get("created_at"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let assets: Vec<(String, String)> = latest
        .pointer("/assets/links")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|link| {
                    let name = link.get("name")?.as_str()?.to_string();
                    let url = link.get("url")?.as_str()?.to_string();
                    Some((name, url))
                })
                .collect()
        })
        .unwrap_or_default();

    let download_url = choose_zip_asset(&assets)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!("https://gitlab.com/{owner}/{repo}/-/archive/{tag}/{repo}-{tag}.zip")
        });

    Ok(Resolved {
        r#ref: Ref::Release { tag, published_at },
        download_url,
        etag: response.header("etag").map(str::to_string),
    })
}

async fn default_branch_head(client: &dyn HttpClient, owner: &str, repo: &str) -> Result<Resolved> {
    let id = project_id(owner, repo);

    let project_url = format!("https://gitlab.com/api/v4/projects/{id}");
    let project_response = client.get(&project_url, &api_headers(None, None)).await?;
    if !project_response.is_success() {
        return Err(Error::HttpStatus {
            status: project_response.status,
            url: project_url,
        });
    }
    let branch = project_response
        .json()?
        .get("default_branch")
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();

    let commit_url = format!("https://gitlab.com/api/v4/projects/{id}/repository/commits/{branch}");
    let commit_response = client.get(&commit_url, &api_headers(None, None)).await?;
    if !commit_response.is_success() {
        return Err(Error::HttpStatus {
            status: commit_response.status,
            url: commit_url,
        });
    }
    let commit_json = commit_response.json()?;
    let sha = commit_json
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::NoResolvableRef(format!("{owner}/{repo}: no commit id")))?
        .to_string();
    let committed_at = commit_json
        .get("committed_date")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok(Resolved {
        download_url: format!(
            "https://gitlab.com/{owner}/{repo}/-/archive/{branch}/{repo}-{branch}.zip"
        ),
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

    /// The bug this guards against was silent and total: gitlab.com answers
    /// `401 Unauthorized` to a bearer token it does not recognise, so anyone
    /// who set a GitHub token in Settings — advertised as a pure improvement —
    /// lost every GitLab addon, which is most of the curated 3.3.5a list.
    ///
    /// Asserted through `sources::resolve`, because that is where the decision
    /// is made and where a future change would undo it.
    #[tokio::test]
    async fn a_gitlab_request_never_carries_the_stored_token() {
        use crate::model::Source;

        let client = FakeHttp::new().json(
            "https://gitlab.com/api/v4/projects/o%2Fr/releases",
            r#"[{"tag_name":"v1.0","released_at":"2026-01-01T00:00:00Z","assets":{"links":[]}}]"#,
        );
        let source = Source::Gitlab {
            owner: "o".into(),
            repo: "r".into(),
        };

        crate::sources::resolve(&client, &source, Channel::Release, Some("ghp_secret"))
            .await
            .unwrap_or_else(|e| panic!("anonymous GitLab requests must work: {e}"));

        assert!(
            !client.saw_header_named("Authorization"),
            "a GitHub token must never be sent to gitlab.com"
        );
    }

    #[tokio::test]
    async fn resolves_the_first_release_in_the_list() {
        let client = FakeHttp::new().json(
            "https://gitlab.com/api/v4/projects/Tsoukie%2Fclassicapi/releases",
            r#"[{"tag_name":"v3.1","released_at":"2026-01-01T00:00:00Z","assets":{"links":[]}},
                {"tag_name":"v3.0","released_at":"2025-01-01T00:00:00Z","assets":{"links":[]}}]"#,
        );

        let resolved = resolve(&client, "Tsoukie", "classicapi", Channel::Release)
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            resolved.r#ref,
            Ref::Release {
                tag: "v3.1".into(),
                published_at: Some("2026-01-01T00:00:00Z".into())
            }
        );
        assert_eq!(
            resolved.download_url,
            "https://gitlab.com/Tsoukie/classicapi/-/archive/v3.1/classicapi-v3.1.zip"
        );
    }

    #[tokio::test]
    async fn prefers_an_attached_zip_link() {
        let client = FakeHttp::new().json(
            "https://gitlab.com/api/v4/projects/o%2Fr/releases",
            r#"[{"tag_name":"v1.0","assets":{"links":[{"name":"MyAddon.zip","url":"https://gitlab.com/o/r/uploads/MyAddon.zip"}]}}]"#,
        );

        let resolved = resolve(&client, "o", "r", Channel::Release)
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            resolved.download_url,
            "https://gitlab.com/o/r/uploads/MyAddon.zip"
        );
    }

    #[tokio::test]
    async fn an_empty_release_list_errors_rather_than_switching_channel() {
        let client =
            FakeHttp::new().json("https://gitlab.com/api/v4/projects/o%2Fr/releases", "[]");
        let result = resolve(&client, "o", "r", Channel::Release).await;
        assert!(matches!(result, Err(Error::NoResolvableRef(_))));
    }

    #[tokio::test]
    async fn resolves_the_default_branch_head() {
        let client = FakeHttp::new()
            .json(
                "https://gitlab.com/api/v4/projects/o%2Fr",
                r#"{"default_branch":"master"}"#,
            )
            .json(
                "https://gitlab.com/api/v4/projects/o%2Fr/repository/commits/master",
                r#"{"id":"cafebabe","committed_date":"2026-03-03T00:00:00Z"}"#,
            );

        let resolved = resolve(&client, "o", "r", Channel::Source)
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            resolved.r#ref,
            Ref::Branch {
                branch: "master".into(),
                sha: "cafebabe".into(),
                committed_at: Some("2026-03-03T00:00:00Z".into())
            }
        );
    }

    #[tokio::test]
    async fn surfaces_api_errors() {
        let client = FakeHttp::new().status(
            "https://gitlab.com/api/v4/projects/o%2Fr/releases",
            403,
            "{}",
        );
        let result = resolve(&client, "o", "r", Channel::Release).await;
        assert!(matches!(result, Err(Error::HttpStatus { status: 403, .. })));
    }
}
