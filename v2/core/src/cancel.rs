//! Cancelling long-running work.
//!
//! Update checks are the case that matters: with thirty addons and a slow
//! forge, a sweep can run for a while, and a user who realises they picked the
//! wrong server should not have to wait it out.
//!
//! Deliberately a flag rather than aborting futures. Cancelling means "stop
//! *starting* new work", not "kill whatever is in flight" — a request that has
//! already been issued is allowed to finish, so nothing is left half-done and
//! no partially-written state can result.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A shared cancellation flag.
///
/// Cloning gives another handle to the *same* flag, so the UI can hold one and
/// the running operation another.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask the operation to stop. Idempotent.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// A token that is already cancelled, for tests and early exits.
    pub fn cancelled() -> Self {
        let token = Self::new();
        token.cancel();
        token
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_uncancelled() {
        assert!(!CancelToken::new().is_cancelled());
    }

    #[test]
    fn cancelling_is_visible_through_every_clone() {
        let token = CancelToken::new();
        let handle = token.clone();
        assert!(!handle.is_cancelled());

        token.cancel();

        assert!(handle.is_cancelled(), "a clone shares the same flag");
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancelling_twice_is_harmless() {
        let token = CancelToken::new();
        token.cancel();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn a_pre_cancelled_token_reports_immediately() {
        assert!(CancelToken::cancelled().is_cancelled());
    }
}
