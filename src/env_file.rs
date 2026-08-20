use std::{collections::BTreeMap, env, fs, io::ErrorKind, path::PathBuf};

use anyhow::{Context, Result, bail};

const DEFAULT_ENV_FILE: &str = ".env";

/// Load SourceNerve's root `.env` file before the async runtime starts.
///
/// Existing process environment variables always win over values from the file.
/// The file is optional: a missing file is not an error, but an unreadable or
/// malformed file fails startup so production configuration does not degrade
/// silently.
pub fn load_root_env_file() -> Result<Option<PathBuf>> {
    let path = env::var_os("SOURCENERVE_ENV_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ENV_FILE));

    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read env file at {}", path.display()));
        }
    };

    let values = parse_env_file(&raw)
        .with_context(|| format!("invalid SourceNerve env file at {}", path.display()))?;

    for (key, value) in values {
        if env::var_os(&key).is_none() {
            // SAFETY: this function is called synchronously from process entry,
            // before the Tokio multi-thread runtime is constructed and before
            // SourceNerve spawns any threads or tasks. No concurrent environment
            // access can occur from SourceNerve at this point.
            unsafe { env::set_var(key, value) };
        }
    }

    Ok(Some(path))
}

fn parse_env_file(raw: &str) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();

    for (index, original) in raw.lines().enumerate() {
        let line_number = index + 1;
        let line = original.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("export ") {
            bail!("line {line_number}: use KEY=VALUE in .env; shell export syntax is not allowed");
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            bail!("line {line_number}: expected KEY=VALUE");
        };
        let key = key.trim();
        validate_key(key, line_number)?;
        let value = parse_value(raw_value.trim(), line_number)?;

        // Match common dotenv behavior: the last value in the file wins.
        values.insert(key.to_string(), value);
    }

    Ok(values)
}

fn validate_key(key: &str, line_number: usize) -> Result<()> {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        bail!("line {line_number}: environment variable name is empty");
    };
    if !(first.is_ascii_alphabetic() || first == '_')
        || !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        bail!(
            "line {line_number}: invalid environment variable name '{key}'; use letters, digits, and '_'"
        );
    }
    Ok(())
}

fn parse_value(raw: &str, line_number: usize) -> Result<String> {
    if raw.is_empty() {
        return Ok(String::new());
    }

    if raw.starts_with('"') {
        if raw.len() < 2 || !raw.ends_with('"') {
            bail!("line {line_number}: unterminated double-quoted value");
        }
        return unescape_double_quoted(&raw[1..raw.len() - 1], line_number);
    }

    if raw.starts_with('\'') {
        if raw.len() < 2 || !raw.ends_with('\'') {
            bail!("line {line_number}: unterminated single-quoted value");
        }
        return Ok(raw[1..raw.len() - 1].to_string());
    }

    let bytes = raw.as_bytes();
    let comment_start = bytes.iter().enumerate().find_map(|(index, byte)| {
        if *byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            Some(index)
        } else {
            None
        }
    });
    let value = comment_start.map_or(raw, |index| &raw[..index]);
    Ok(value.trim_end().to_string())
}

fn unescape_double_quoted(raw: &str, line_number: usize) -> Result<String> {
    let mut output = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        let Some(escaped) = chars.next() else {
            bail!("line {line_number}: trailing escape in double-quoted value");
        };
        match escaped {
            '\\' => output.push('\\'),
            '"' => output.push('"'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            other => {
                output.push('\\');
                output.push(other);
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_comments_quotes_and_inline_comments() {
        let parsed = parse_env_file(
            r#"
            # comment
            SOURCENERVE_BEARER_TOKEN=abc123 # local comment
            SOURCENERVE_GITHUB_TOKEN='github_pat_123#literal'
            RUST_LOG="sourcenerve=debug"
            EMPTY=
            "#,
        )
        .unwrap();

        assert_eq!(parsed["SOURCENERVE_BEARER_TOKEN"], "abc123");
        assert_eq!(parsed["SOURCENERVE_GITHUB_TOKEN"], "github_pat_123#literal");
        assert_eq!(parsed["RUST_LOG"], "sourcenerve=debug");
        assert_eq!(parsed["EMPTY"], "");
    }

    #[test]
    fn rejects_shell_export_syntax() {
        assert!(parse_env_file("export VALUE=not-allowed\n").is_err());
    }

    #[test]
    fn last_duplicate_value_wins() {
        let parsed = parse_env_file("VALUE=first\nVALUE=second\n").unwrap();
        assert_eq!(parsed["VALUE"], "second");
    }

    #[test]
    fn rejects_invalid_lines_and_keys() {
        assert!(parse_env_file("NOT_AN_ASSIGNMENT").is_err());
        assert!(parse_env_file("1INVALID=value").is_err());
        assert!(parse_env_file("BAD-NAME=value").is_err());
    }

    #[test]
    fn supports_basic_double_quote_escapes() {
        let parsed = parse_env_file("VALUE=\"line1\\nline2\\t\\\"quoted\\\"\"\n").unwrap();
        assert_eq!(parsed["VALUE"], "line1\nline2\t\"quoted\"");
    }
}
