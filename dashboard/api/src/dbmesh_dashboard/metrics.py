"""Fixed, bounded PromQL queries for the dashboard; never accept arbitrary PromQL."""

from __future__ import annotations

import json
import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)


class MetricRow(BaseModel):
    database: str
    operation: str
    target: str
    reader: str
    outcome: str
    count: float
    per_second: float


class MetricsSnapshot(BaseModel):
    window: str
    sampled_at: float
    targets_up: int
    targets_total: int
    rows: list[MetricRow]
    p95_seconds: float | None


Window = Literal["5m", "15m", "1h", "6h", "24h"]
LABELS = ("database", "operation", "target", "reader", "outcome")
# One row per sample fired off in parallel; the pool is sized to match and reused across
# requests so a call does not pay thread creation/teardown on every poll.
_QUERIES_PER_SNAPSHOT = 4


class MetricsStore:
    def __init__(self, url: str, databases: tuple[str, ...]):
        self.url = url.rstrip("/")
        self.databases = databases
        self._pool = ThreadPoolExecutor(max_workers=_QUERIES_PER_SNAPSHOT, thread_name_prefix="dbmesh-metrics")

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

    def _query(self, expression: str, timestamp: float) -> list[dict]:
        params = urlencode({"query": expression, "time": timestamp, "timeout": "3s"})
        try:
            with urlopen(f"{self.url}/api/v1/query?{params}", timeout=5) as response:
                body = json.load(response)
            if not isinstance(body, dict) or body.get("status") != "success":
                raise ValueError("unexpected Prometheus response")
            data = body["data"]
            if not isinstance(data, dict) or data.get("resultType") != "vector" or not isinstance(data.get("result"), list):
                raise ValueError("unexpected Prometheus data")
            return data["result"]
        except (URLError, OSError, ValueError, KeyError, TypeError):
            raise HTTPException(503, "Prometheus unavailable or returned an invalid response") from None

    def snapshot(self, window: Window, database: str | None = None) -> MetricsSnapshot:
        if database is not None and database not in self.databases:
            raise HTTPException(404, "unknown database")
        # JSON string escaping is also valid for these PromQL string literals.
        if database is not None:
            selector = f'job="dbmesh",database={json.dumps(database)}'
        else:
            # Match configured names literally, including regex metacharacters.
            names = "|".join(re.escape(name) for name in self.databases)
            selector = f'job="dbmesh",database=~{json.dumps(names)}'
        group = ",".join(LABELS)
        counter = f"dbmesh_queries_total{{{selector}}}"
        bucket = f"dbmesh_query_duration_seconds_bucket{{{selector}}}"
        expressions = [
            f"sum by ({group}) (increase({counter}[{window}]))",
            f"sum by ({group}) (rate({counter}[{window}]))",
            f"histogram_quantile(0.95, sum by (le) (rate({bucket}[{window}])))",
            'up{job="dbmesh"}',
        ]
        timestamp = time.time()
        counts, rates, latency, health = list(self._pool.map(lambda q: self._query(q, timestamp), expressions))

        rate_map: dict[tuple[str, ...], float] = {}
        for row in rates:
            value = self._try_number(row, "rate")
            if value is not None:
                rate_map[self._key(row)] = value

        rows: list[MetricRow] = []
        for row in counts:
            count = self._try_number(row, "count")
            if count is None:
                continue
            try:
                key = self._key(row)
                rows.append(MetricRow(**dict(zip(LABELS, key)), count=count, per_second=rate_map.get(key, 0)))
            except (KeyError, TypeError, ValidationError) as err:
                logger.warning("dropping metric count sample with unexpected labels %r: %s", row, err)

        p95 = self._try_number(latency[0], "p95") if latency else None

        up = sum(1 for row in health if self._try_number(row, "health") == 1)

        return MetricsSnapshot(window=window, sampled_at=timestamp, targets_up=up, targets_total=len(health),
                               rows=sorted(rows, key=lambda row: (row.database, row.operation, row.target, row.reader, row.outcome)),
                               p95_seconds=p95)

    @staticmethod
    def _key(row: dict) -> tuple[str, ...]:
        return tuple(row["metric"][label] for label in LABELS)

    @staticmethod
    def _number(row: dict) -> float:
        value = float(row["value"][1])
        if not math.isfinite(value) or value < 0:
            raise ValueError("invalid counter sample")
        return value

    @classmethod
    def _try_number(cls, row: dict, what: str) -> float | None:
        """Like _number, but a bad sample is dropped (with a log) rather than failing the whole snapshot.

        A single stray value - for example a fleeting negative rate() extrapolation right after
        DBMesh restarts and resets its counters - must not take down every other series.
        """
        try:
            return cls._number(row)
        except (ValueError, KeyError, TypeError, IndexError) as err:
            logger.warning("dropping invalid Prometheus %s sample %r: %s", what, row, err)
            return None
