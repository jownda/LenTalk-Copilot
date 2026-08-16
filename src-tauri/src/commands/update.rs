use reqwest::{header, Client};
use serde::{Deserialize, Serialize};

const GITHUB_RELEASES_LATEST_API: &str =
    "https://api.github.com/repos/jownda/LenTalk-Copilot/releases/latest";
const GITHUB_RELEASES_LATEST_PAGE: &str =
    "https://github.com/jownda/LenTalk-Copilot/releases/latest";

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubLatestReleaseResponse {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Serialize)]
pub struct LatestReleaseInfo {
    pub version: String,
    pub release_url: String,
    pub download_url: Option<String>,
    pub release_notes: Option<String>,
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches(['v', 'V']).to_string()
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|error| format!("failed to build http client: {error}"))
}

fn is_matching_platform_asset(name: &str, extension: &str, architecture_hint: Option<&str>) -> bool {
  let normalized = name.to_ascii_lowercase();
  normalized.ends_with(extension)
    && architecture_hint.is_none_or(|hint| normalized.contains(hint))
}

fn has_explicit_architecture_hint(name: &str) -> bool {
  let normalized = name.to_ascii_lowercase();
  ["aarch64", "arm64", "x64", "x86_64", "x86"]
    .iter()
    .any(|hint| normalized.contains(hint))
}

fn is_universal_platform_asset(name: &str, extension: &str) -> bool {
  name.to_ascii_lowercase().ends_with(extension) && !has_explicit_architecture_hint(name)
}

fn select_platform_asset(assets: &[GithubReleaseAsset]) -> Option<String> {
    let os = std::env::consts::OS;
    let extension = match os {
        "macos" => ".dmg",
        "windows" => ".exe",
        _ => return None,
    };
    let architecture_hint = match std::env::consts::ARCH {
        "aarch64" => Some("aarch64"),
        "x86_64" => Some("x64"),
        _ => None,
    };

    assets
        .iter()
        .find(|asset| is_matching_platform_asset(&asset.name, extension, architecture_hint))
        .or_else(|| {
          assets
            .iter()
            .find(|asset| is_universal_platform_asset(&asset.name, extension))
        })
        .map(|asset| asset.browser_download_url.clone())
        .or_else(|| {
            if os != "windows" {
                return None;
            }

            assets
                .iter()
                .find(|asset| is_matching_platform_asset(&asset.name, ".msi", architecture_hint))
                .or_else(|| {
                  assets
                    .iter()
                    .find(|asset| is_universal_platform_asset(&asset.name, ".msi"))
                })
                .map(|asset| asset.browser_download_url.clone())
        })
}

async fn fetch_latest_release() -> Result<LatestReleaseInfo, String> {
    let response = build_http_client()?
        .get(GITHUB_RELEASES_LATEST_API)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(header::USER_AGENT, "LenTalk-Updater")
        .send()
        .await
        .map_err(|error| format!("github api request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "github latest release request failed: status {}",
            response.status()
        ));
    }

    let payload = response
        .json::<GithubLatestReleaseResponse>()
        .await
        .map_err(|error| format!("failed to decode github api response: {error}"))?;
    let version = normalize_version(payload.tag_name.as_deref().unwrap_or_default());
    if version.is_empty() {
        return Err("github latest release is missing tag_name".to_string());
    }

    Ok(LatestReleaseInfo {
        version,
        release_url: payload
            .html_url
            .unwrap_or_else(|| GITHUB_RELEASES_LATEST_PAGE.to_string()),
        download_url: select_platform_asset(&payload.assets),
        release_notes: payload.body.filter(|body| !body.trim().is_empty()),
    })
}

#[tauri::command]
pub async fn get_latest_release_info() -> Result<LatestReleaseInfo, String> {
    fetch_latest_release().await
}

#[cfg(test)]
mod tests {
    use super::{has_explicit_architecture_hint, is_matching_platform_asset, select_platform_asset, GithubReleaseAsset};

    #[test]
    fn filters_assets_by_extension_and_architecture() {
        assert!(is_matching_platform_asset(
            "LenTalk_1.2.3_aarch64.dmg",
            ".dmg",
            Some("aarch64")
        ));
        assert!(!is_matching_platform_asset(
            "LenTalk_1.2.3_x64-setup.exe",
            ".dmg",
            Some("aarch64")
        ));
    }

    #[test]
    fn recognizes_architecture_specific_asset_names() {
        assert!(has_explicit_architecture_hint("LenTalk_1.2.3_aarch64.dmg"));
        assert!(has_explicit_architecture_hint("LenTalk_1.2.3_x64-setup.exe"));
        assert!(!has_explicit_architecture_hint("LenTalk_1.2.3.dmg"));
    }

    #[test]
    fn selects_an_asset_for_the_current_desktop_platform() {
        let assets = vec![
            GithubReleaseAsset {
                name: "LenTalk_1.2.3_aarch64.dmg".to_string(),
                browser_download_url: "https://example.com/LenTalk_1.2.3_aarch64.dmg".to_string(),
            },
            GithubReleaseAsset {
                name: "LenTalk_1.2.3_x64-setup.exe".to_string(),
                browser_download_url: "https://example.com/LenTalk_1.2.3_x64-setup.exe".to_string(),
            },
        ];

        let selected = select_platform_asset(&assets);
        if cfg!(target_os = "macos") {
            assert_eq!(
                selected.as_deref(),
                Some("https://example.com/LenTalk_1.2.3_aarch64.dmg")
            );
        }
    }
}
