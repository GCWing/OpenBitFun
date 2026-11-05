//! Session context compression modules.
//!
//! NOTE: The earlier `microcompact` pre-compression layer (which silently
//! erased the contents of older tool results to free tokens) has been
//! removed.  It mutated already-sent message prefixes — invalidating provider
//! KV caches on every pass — and stripped the model of memory of what it had
//! already done, which directly drove repetitive tool-call loops in long
//! exploratory subagents. Token pressure uses model summaries by default.
//! Explicit `/compact force` or the global local-truncation policy can instead
//! discard complete old message units without rewriting retained messages or
//! synthesizing a summary. Both transformations live in `compressor.rs`. As a final
//! safety-net only, the `emergency_truncate_messages` path in
//! `execution_engine.rs`.

pub mod compressor;

pub use compressor::*;
