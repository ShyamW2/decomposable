"""The contract every Decomposable Python worker implements.

One process, one model, newline-delimited JSON on stdout, logs on stderr. There
is no job framework here on purpose (ADR-007): the kernel makes a call, the call
reports progress, and the call can be cancelled.
"""

from .worker import Cancelled, Job, Progress, Worker, log, serve

__all__ = ["Cancelled", "Job", "Progress", "Worker", "log", "serve"]
