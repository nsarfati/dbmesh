"""One shared password, a signed session cookie and a small login throttle."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from collections import defaultdict, deque

COOKIE = "dbmesh_session"
SESSION_SECONDS = 8 * 3600
MAX_FAILURES = 5
FAILURE_WINDOW = 60.0


class SessionSigner:
    """Stateless `<expiry>.<signature>` tokens; restarting the API ends every session."""

    def __init__(self, secret: bytes, lifetime: int = SESSION_SECONDS, clock=time.time):
        self._secret, self._lifetime, self._clock = secret, lifetime, clock

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._secret, payload.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")

    def issue(self) -> str:
        expires = str(int(self._clock()) + self._lifetime)
        return f"{expires}.{self._sign(expires)}"

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        expires, _, signature = token.partition(".")
        if not expires.isdigit() or not hmac.compare_digest(signature, self._sign(expires)):
            return False
        return int(expires) > self._clock()


class LoginThrottle:
    """Blocks a client after too many failed logins in a short window."""

    def __init__(self, limit: int = MAX_FAILURES, window: float = FAILURE_WINDOW, clock=time.monotonic):
        self._limit, self._window, self._clock = limit, window, clock
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def _recent(self, client: str) -> deque[float]:
        failures = self._failures[client]
        while failures and self._clock() - failures[0] > self._window:
            failures.popleft()
        return failures

    def blocked(self, client: str) -> bool:
        return len(self._recent(client)) >= self._limit

    def record_failure(self, client: str) -> None:
        self._recent(client).append(self._clock())

    def reset(self, client: str) -> None:
        self._failures.pop(client, None)


def password_matches(expected: str, given: str) -> bool:
    return hmac.compare_digest(expected.encode(), given.encode())
