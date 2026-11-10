(module
  ;; Redirect stdin to a file containing "input"; stdout/stderr receive that text.
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func $ok (param $errno i32) (if (local.get $errno) (then unreachable)))
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 128))
    (i32.store (i32.const 4) (i32.const 5))
    (call $ok (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 16)))
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 5)) (then unreachable))
    (call $ok (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
    (call $ok (call $write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 20)))))
