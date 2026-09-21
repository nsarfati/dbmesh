from dbmesh_dashboard.auth import LoginThrottle, SessionSigner, password_matches


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


def test_token_round_trip_and_expiry():
    clock = Clock()
    signer = SessionSigner(b"k" * 32, lifetime=60, clock=clock)
    token = signer.issue()
    assert signer.valid(token)
    clock.now += 59
    assert signer.valid(token)
    clock.now += 2
    assert not signer.valid(token)


def test_tampered_or_foreign_tokens_are_rejected():
    signer = SessionSigner(b"a" * 32)
    token = signer.issue()
    expires, _, signature = token.partition(".")
    assert not signer.valid(f"{int(expires) + 1000}.{signature}")
    assert not signer.valid(SessionSigner(b"b" * 32).issue())
    for junk in (None, "", "nodot", "abc.def", ".", "1.2.3"):
        assert not signer.valid(junk)


def test_throttle_blocks_then_recovers():
    clock = Clock()
    throttle = LoginThrottle(limit=3, window=60, clock=clock)
    for _ in range(3):
        assert not throttle.blocked("1.2.3.4")
        throttle.record_failure("1.2.3.4")
    assert throttle.blocked("1.2.3.4")
    assert not throttle.blocked("5.6.7.8")
    clock.now += 61
    assert not throttle.blocked("1.2.3.4")


def test_throttle_reset_on_success():
    throttle = LoginThrottle(limit=2)
    throttle.record_failure("c")
    throttle.record_failure("c")
    throttle.reset("c")
    assert not throttle.blocked("c")


def test_password_matches():
    assert password_matches("secret", "secret")
    assert not password_matches("secret", "Secret")
    assert password_matches("señal", "señal")
