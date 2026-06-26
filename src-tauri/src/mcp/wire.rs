use crate::mcp::McpError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// Hard upper bound on a single IPC frame (16 MiB). A note larger than this is
/// not a sane MCP read; bounding the prefix prevents a hostile length from
/// triggering an unbounded allocation.
pub const MAX_FRAME: u32 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum IpcRequest {
    /// Fetch the app-supplied capability manifest (drives the shim handshake).
    Manifest {
        token: String,
    },
    List {
        token: String,
    },
    ReadNote {
        token: String,
        canonical: String,
    },
    Search {
        token: String,
        query: String,
        limit: usize,
    },
    /// Subscribe to vault-change notifications (relay wired in Phase 4).
    Subscribe {
        token: String,
    },
}

impl IpcRequest {
    pub fn token(&self) -> &str {
        match self {
            IpcRequest::Manifest { token }
            | IpcRequest::List { token }
            | IpcRequest::ReadNote { token, .. }
            | IpcRequest::Search { token, .. }
            | IpcRequest::Subscribe { token } => token,
        }
    }
}

// Hand-written Debug so a stray {:?} can never print the token.
impl std::fmt::Debug for IpcRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            IpcRequest::Manifest { .. } => "Manifest",
            IpcRequest::List { .. } => "List",
            IpcRequest::ReadNote { .. } => "ReadNote",
            IpcRequest::Search { .. } => "Search",
            IpcRequest::Subscribe { .. } => "Subscribe",
        };
        write!(f, "IpcRequest::{name} {{ token: \"[REDACTED]\", .. }}")
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum IpcResponse {
    Manifest(crate::mcp::manifest::CapabilityManifest),
    List {
        paths: Vec<String>,
    },
    Note {
        content: String,
    },
    Search {
        hits: Vec<crate::kb::search::SearchHit>,
    },
    /// Vault-change notification pushed from server to shim (Phase 4 relay).
    Changed {
        canonical: String,
    },
    Error {
        kind: String,
        message: String,
    },
}

/// 4-byte big-endian length prefix, then the JSON body.
pub fn write_frame<W: Write>(w: &mut W, value: &impl Serialize) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let len = body.len() as u32;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

/// Read one length-prefixed JSON frame; bound the length by MAX_FRAME.
pub fn read_frame<R: Read, T: DeserializeOwned>(r: &mut R) -> Result<T, McpError> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)
        .map_err(|e| McpError::Io(e.to_string()))?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(McpError::Protocol(format!("frame too large: {len}")));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)
        .map_err(|e| McpError::Io(e.to_string()))?;
    serde_json::from_slice(&body).map_err(|e| McpError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_round_trips() {
        let req = IpcRequest::Search {
            token: "spk_mcp_test".into(),
            query: "alpha".into(),
            limit: 10,
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &req).unwrap();
        // 4-byte prefix present.
        assert!(buf.len() > 4);
        let mut cur = Cursor::new(buf);
        let back: IpcRequest = read_frame(&mut cur).unwrap();
        match back {
            IpcRequest::Search {
                token,
                query,
                limit,
            } => {
                assert_eq!(token, "spk_mcp_test");
                assert_eq!(query, "alpha");
                assert_eq!(limit, 10);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn oversized_frame_is_rejected() {
        // A length prefix above MAX_FRAME must error, not allocate.
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME + 1).to_be_bytes());
        let mut cur = Cursor::new(buf);
        let res: Result<IpcRequest, _> = read_frame(&mut cur);
        assert!(res.is_err());
    }

    #[test]
    fn request_debug_redacts_token() {
        let req = IpcRequest::List {
            token: "spk_mcp_secret".into(),
        };
        let dbg = format!("{req:?}");
        assert!(!dbg.contains("spk_mcp_secret"));
        assert!(dbg.contains("REDACTED"));
    }

    #[test]
    fn subscribe_round_trips_and_debug_redacts_token() {
        let req = IpcRequest::Subscribe {
            token: "spk_mcp_sub_secret".into(),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &req).unwrap();
        assert!(buf.len() > 4);
        let mut cur = Cursor::new(buf);
        let back: IpcRequest = read_frame(&mut cur).unwrap();
        match back {
            IpcRequest::Subscribe { token } => assert_eq!(token, "spk_mcp_sub_secret"),
            _ => panic!("wrong variant"),
        }
        let dbg = format!("{req:?}");
        assert!(!dbg.contains("spk_mcp_sub_secret"));
        assert!(dbg.contains("REDACTED"));
        assert!(dbg.contains("Subscribe"));
    }
}
