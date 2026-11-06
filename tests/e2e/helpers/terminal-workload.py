"""Bounded PTY workload, launched and controlled through the actual terminal UI."""

import argparse
import json
import os
import select
import signal
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--trace", required=True)
    parser.add_argument("--batch-lines", type=int, default=50)
    parser.add_argument("--interval-ms", type=int, default=50)
    args = parser.parse_args()
    if args.batch_lines <= 0 or args.interval_ms <= 0:
        parser.error("Batch size and interval must be positive")

    trace = open(args.trace, "x", encoding="utf-8", buffering=1)

    def record(event, **details):
        trace.write(json.dumps({"event": event, "atNs": time.monotonic_ns(), **details}) + "\n")

    def emit(text):
        sys.stdout.write(text + "\n")
        sys.stdout.flush()

    def size():
        geometry = os.get_terminal_size(sys.stdin.fileno())
        return {"cols": geometry.columns, "rows": geometry.lines}

    resize_pending = False

    def resized(_signal, _frame):
        nonlocal resize_pending
        resize_pending = True

    signal.signal(signal.SIGWINCH, resized)
    record("ready", pid=os.getpid(), **size())
    emit(f"WORKLOAD_READY_{args.id}")
    pending = ""
    remaining = 0
    batch = 0
    last_ping = "none"
    next_batch = time.monotonic()
    while True:
        if resize_pending:
            resize_pending = False
            record("resize", **size())
        timeout = max(0, next_batch - time.monotonic()) if remaining else 0.1
        readable, _, _ = select.select([sys.stdin], [], [], timeout)
        if readable:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                record("eof", remaining=remaining)
                break
            pending += data.decode("utf-8")
            while "\n" in pending:
                command, pending = pending.split("\n", 1)
                parts = command.strip().split()
                if not parts:
                    continue
                if parts[0] == "RUN" and len(parts) == 2 and parts[1].isdigit() and int(parts[1]) > 0:
                    if remaining:
                        emit(f"WORKLOAD_BUSY_{args.id}")
                        continue
                    remaining = int(parts[1])
                    batch = 0
                    next_batch = time.monotonic() + args.interval_ms / 1000
                    record("run", batches=remaining, batchLines=args.batch_lines, intervalMs=args.interval_ms)
                    emit(f"WORKLOAD_RUNNING_{args.id}")
                elif parts[0] == "PING" and len(parts) == 2:
                    last_ping = parts[1]
                    record("ping", token=last_ping, batch=batch)
                    emit(f"WORKLOAD_ACK_{args.id}_{last_ping}")
                elif parts[0] == "STATE":
                    state = {"batch": batch, "remaining": remaining, **size()}
                    record("state", **state)
                    emit(f"WORKLOAD_STATE_{args.id} " + json.dumps(state))
                elif parts[0] == "EXIT":
                    record("exit", batch=batch, remaining=remaining)
                    emit(f"WORKLOAD_EXIT_{args.id}")
                    trace.close()
                    return
                else:
                    record("invalid-command", command=command)
                    emit(f"WORKLOAD_INVALID_{args.id}")
        if remaining and time.monotonic() >= next_batch:
            start = batch * args.batch_lines
            sys.stdout.write("".join(
                f"\x1b[36m{args.id} output {line:08d}\x1b[0m "
                "0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\n"
                for line in range(start, start + args.batch_lines)
            ))
            batch += 1
            remaining -= 1
            emit(f"WORKLOAD_ACK_{args.id}_{last_ping}")
            if not remaining:
                record("done", batches=batch, lines=batch * args.batch_lines)
                emit(f"WORKLOAD_DONE_{args.id}_{batch}")
            next_batch = time.monotonic() + args.interval_ms / 1000
    trace.close()


if __name__ == "__main__":
    main()
