//! Per-function opt-in gate (worklist #4).
//!
//! Optimization/cleanup passes must only mutate code inside *opted-in*
//! functions (those whose subtree carries a directive — see
//! [`super::directives::touched_functions`]). They still *recurse* everywhere
//! (to reach a touched function nested inside an untouched one), but only
//! *mutate* when `active`.
//!
//! Usage in a `VisitMut` pass:
//! ```ignore
//! fn visit_function(&mut self, f, flags) {
//!     let s = self.gate.enter(f.span.start);
//!     walk_mut::walk_function(self, f, flags);
//!     self.gate.exit(s);
//! }
//! // ...and guard each mutation with `if self.gate.active { … }`.
//! ```
//! `Gate::ungated()` keeps the legacy whole-program behavior (used by the
//! per-pass harness / `run_one`); `Gate::gated(touched)` restricts to the set.

use std::collections::HashSet;
use std::rc::Rc;

#[derive(Clone)]
pub(crate) struct Gate {
    touched: Option<Rc<HashSet<u32>>>,
    /// Whether the current position is inside an opted-in function (always true
    /// when ungated).
    pub active: bool,
}

impl Gate {
    pub fn ungated() -> Self {
        Gate { touched: None, active: true }
    }

    pub fn gated(touched: Rc<HashSet<u32>>) -> Self {
        Gate { touched: Some(touched), active: false }
    }

    /// Enter a **function/arrow** boundary (span start `start`). Functions are
    /// independent units, so `active` *resets* to whether this function is
    /// itself opted-in — a nested untouched function inside a touched scope is
    /// NOT optimized. Returns the prior `active` for [`Gate::exit`].
    pub fn enter_fn(&mut self, start: u32) -> bool {
        let saved = self.active;
        if let Some(t) = &self.touched {
            self.active = t.contains(&start);
        }
        saved
    }

    /// Enter a **block/loop/statement** scope (span start `start`). `active`
    /// *inherits* — once inside an opted-in construct we stay active for the
    /// whole subtree — or turns on if this scope is itself directive-attached
    /// (`/* @optimize */ { … }`).
    pub fn enter_scope(&mut self, start: u32) -> bool {
        let saved = self.active;
        if let Some(t) = &self.touched {
            self.active = self.active || t.contains(&start);
        }
        saved
    }

    pub fn exit(&mut self, saved: bool) {
        self.active = saved;
    }
}
