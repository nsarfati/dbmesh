"""Fixed, bounded PromQL queries for the dashboard; never accept arbitrary PromQL."""

from __future__ import annotations

import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import HTTPException
from pydantic import BaseModel


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


class MetricsStore:
    def __init__(self, url: str, databases: tuple[str, ...]):
        self.url = url.rstrip("/")
        self.databases = databases

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
        with ThreadPoolExecutor(max_workers=4) as pool:
            counts, rates, latency, health = list(pool.map(lambda q: self._query(q, timestamp), expressions))
        try:
            rate_map = {self._key(row): self._number(row) for row in rates}
            rows = [MetricRow(**dict(zip(LABELS, self._key(row))), count=self._number(row),
                              per_second=rate_map.get(self._key(row), 0)) for row in counts]
            p95 = float(latency[0]["value"][1]) if latency else float("nan")
            up = sum(self._number(row) == 1 for row in health)
        except (ValueError, KeyError, TypeError, IndexError):
            raise HTTPException(503, "Prometheus returned invalid metric samples") from None
        return MetricsSnapshot(window=window, sampled_at=timestamp, targets_up=up, targets_total=len(health),
                               rows=sorted(rows, key=lambda row: (row.database, row.operation, row.target, row.reader, row.outcome)),
                               p95_seconds=p95 if math.isfinite(p95) else None)

    @staticmethod
    def _key(row: dict) -> tuple[str, ...]:
        return tuple(row["metric"][label] for label in LABELS)

    @staticmethod
    def _number(row: dict) -> float:
        value = float(row["value"][1])
        if not math.isfinite(value) or value < 0:
            raise ValueError("invalid counter sample")
        return value
