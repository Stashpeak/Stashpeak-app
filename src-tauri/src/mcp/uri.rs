use crate::mcp::McpError;

const SCHEME_AUTHORITY: &str = "kb://vault/";

/// True for RFC 3986 `unreserved`: A-Z a-z 0-9 - . _ ~
fn is_unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

/// Percent-encode one path segment over its UTF-8 bytes, uppercase hex.
fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for &b in seg.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// canonical (NFC, `/`-separated, no leading slash) -> `kb://vault/<encoded>`.
pub fn canonical_to_uri(canonical: &str) -> String {
    if canonical.is_empty() {
        return SCHEME_AUTHORITY.to_string();
    }
    let encoded = canonical
        .split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("{SCHEME_AUTHORITY}{encoded}")
}

/// Percent-decode one segment's UTF-8 bytes back to a String.
fn decode_segment(seg: &str) -> Result<String, McpError> {
    let bytes = seg.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return Err(McpError::Protocol(format!(
                        "truncated percent escape in {seg}"
                    )));
                }
                let hi = (bytes[i + 1] as char)
                    .to_digit(16)
                    .ok_or_else(|| McpError::Protocol(format!("bad percent escape in {seg}")))?;
                let lo = (bytes[i + 2] as char)
                    .to_digit(16)
                    .ok_or_else(|| McpError::Protocol(format!("bad percent escape in {seg}")))?;
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| McpError::Protocol(format!("invalid utf8 in {seg}")))
}

/// `kb://vault/<encoded>` -> canonical string. Rejects wrong scheme/authority,
/// any query/fragment, and (after decode) any traversal/absolute form.
pub fn uri_to_canonical(uri: &str) -> Result<String, McpError> {
    if uri.contains('?') || uri.contains('#') {
        return Err(McpError::Protocol("query/fragment not allowed".into()));
    }
    let rest = uri
        .strip_prefix(SCHEME_AUTHORITY)
        .ok_or_else(|| McpError::Protocol(format!("not a kb://vault/ uri: {uri}")))?;
    if rest.is_empty() {
        return Ok(String::new()); // the root
    }
    let mut segs = Vec::new();
    for seg in rest.split('/') {
        let decoded = decode_segment(seg)?;
        // Reject smuggled traversal/empty/separators after decode.
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\u{0000}')
        {
            return Err(McpError::Protocol(format!("rejected segment: {decoded}")));
        }
        segs.push(decoded);
    }
    Ok(segs.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_space_as_uppercase_percent20() {
        // §5.3 example, byte-for-byte.
        assert_eq!(
            canonical_to_uri("Projects/Q3 plan.md"),
            "kb://vault/Projects/Q3%20plan.md"
        );
    }

    #[test]
    fn keeps_unreserved_and_separators_raw() {
        assert_eq!(
            canonical_to_uri("a-b_c.d~e/F.md"),
            "kb://vault/a-b_c.d~e/F.md"
        );
    }

    #[test]
    fn root_is_kb_vault_slash() {
        assert_eq!(canonical_to_uri(""), "kb://vault/");
    }

    #[test]
    fn encodes_non_ascii_utf8_bytes_uppercase() {
        // "é" (U+00E9) NFC = UTF-8 0xC3 0xA9 -> %C3%A9
        assert_eq!(
            canonical_to_uri("caf\u{00e9}.md"),
            "kb://vault/caf%C3%A9.md"
        );
    }

    #[test]
    fn round_trips() {
        for c in [
            "Projects/Q3 plan.md",
            "caf\u{00e9}.md",
            "a/b/c.md",
            "100%done.md",
        ] {
            assert_eq!(uri_to_canonical(&canonical_to_uri(c)).unwrap(), c);
        }
    }

    #[test]
    fn decode_rejects_wrong_scheme_authority_query_fragment() {
        assert!(uri_to_canonical("file:///etc/passwd").is_err());
        assert!(uri_to_canonical("kb://other/x.md").is_err());
        assert!(uri_to_canonical("kb://vault/x.md?q=1").is_err());
        assert!(uri_to_canonical("kb://vault/x.md#frag").is_err());
    }

    #[test]
    fn decode_rejects_traversal_after_decode() {
        // A percent-encoded ".." must not smuggle traversal back in.
        assert!(uri_to_canonical("kb://vault/%2E%2E/secret.md").is_err());
    }
}
