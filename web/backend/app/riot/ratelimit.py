"""Client-side sliding-window rate limiter (async)."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Awaitable, Callable, Sequence

# Riot development key limits: 20 requests / 1 s and 100 requests / 2 min.
DEV_KEY_LIMITS: tuple[tuple[int, float], ...] = ((20, 1.0), (100, 120.0))


class RateLimiter:
    def __init__(
        self,
        limits: Sequence[tuple[int, float]] = DEV_KEY_LIMITS,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.limits = [(int(n), float(p)) for n, p in limits]
        self._clock = clock
        self._sleep = sleep
        self._events: deque[float] = deque()
        self._lock: asyncio.Lock | None = None
        self._max_period = max((p for _, p in self.limits), default=0.0)

    def _wait_time(self, now: float) -> float:
        while self._events and now - self._events[0] >= self._max_period:
            self._events.popleft()
        wait = 0.0
        events = list(self._events)
        for limit, period in self.limits:
            recent = [t for t in events if now - t < period]
            if len(recent) >= limit:
                # The oldest request that must leave the window before we may send another one.
                wait = max(wait, recent[len(recent) - limit] + period - now)
        return wait

    async def acquire(self) -> None:
        if not self.limits:
            return
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            while True:
                now = self._clock()
                wait = self._wait_time(now)
                if wait <= 0:
                    self._events.append(now)
                    return
                await self._sleep(wait)
