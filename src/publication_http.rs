use axum::{
    Router,
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};

const LANDING_HTML: &str = include_str!("../public/index.html");
const PRIVACY_HTML: &str = include_str!("../public/privacy.html");
const TERMS_HTML: &str = include_str!("../public/terms.html");
const SUPPORT_HTML: &str = include_str!("../public/support.html");
const ICON_SVG: &str = include_str!("../public/icon.svg");
const OPENAI_APPS_CHALLENGE_ENV: &str = "SOURCENERVE_OPENAI_APPS_CHALLENGE";
const OPENAI_APPS_CHALLENGE_MAX_BYTES: usize = 1024;

fn valid_openai_apps_challenge(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= OPENAI_APPS_CHALLENGE_MAX_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

async fn openai_apps_challenge() -> Response {
    let Ok(value) = std::env::var(OPENAI_APPS_CHALLENGE_ENV) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !valid_openai_apps_challenge(&value) {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        value,
    )
        .into_response()
}

async fn plugin_icon() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        ICON_SVG,
    )
        .into_response()
}

pub fn router() -> Router {
    Router::new()
        .route("/", get(|| async { Html(LANDING_HTML) }))
        .route("/privacy", get(|| async { Html(PRIVACY_HTML) }))
        .route("/terms", get(|| async { Html(TERMS_HTML) }))
        .route("/support", get(|| async { Html(SUPPORT_HTML) }))
        .route("/icon.svg", get(plugin_icon))
        .route(
            "/.well-known/openai-apps-challenge",
            get(openai_apps_challenge),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_apps_challenge_requires_one_bounded_raw_token() {
        assert!(valid_openai_apps_challenge("challenge-token_123"));
        assert!(valid_openai_apps_challenge(&"x".repeat(1024)));
        assert!(!valid_openai_apps_challenge(""));
        assert!(!valid_openai_apps_challenge("contains space"));
        assert!(!valid_openai_apps_challenge("token\nsecond"));
        assert!(!valid_openai_apps_challenge(&"x".repeat(1025)));
    }

    #[test]
    fn publication_pages_and_icon_are_embedded() {
        assert!(LANDING_HTML.contains("SourceNerve"));
        assert!(PRIVACY_HTML.contains("Privacy Policy"));
        assert!(TERMS_HTML.contains("Terms of Use"));
        assert!(SUPPORT_HTML.contains("SourceNerve Support"));
        assert!(ICON_SVG.contains("<svg"));
    }
}
