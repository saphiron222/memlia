# Copyright 2026 Memlia. All rights reserved.
"""Pure opt-in milestone policy; no process, disk or pressure mutations."""

import math

MIN_DISK_BYTES = 40 * 1024**3
TIMEOUT_SECONDS = 5400
CRITICAL_SECONDS = 60
RECOVERY_SECONDS = 15


def valid_sample(sample):
    """Dispatch pressure masks, never XNU's internal enum; unknown means unavailable."""
    return isinstance(sample, dict) and all(
        type(sample.get(key)) is int and sample[key] >= 0
        for key in ('footprintBytes', 'swapBytes', 'diskFreeBytes')
    ) and type(sample.get('pressureLevel')) is int and sample['pressureLevel'] in (1, 2, 4) and (
        type(sample.get('freePercent')) is int and 0 <= sample['freePercent'] <= 100)


def capture_identities(sample):
    """Capture known process identities before independent system measurements can fail."""
    identities = []
    for identity in sample.get('processes', []):
        fields = ('pid', 'uid', 'seconds', 'microseconds', 'status')
        if not isinstance(identity, dict) or any(
                type(identity.get(key)) is not int or identity[key] < 0 for key in fields):
            raise ValueError('monitoring-unavailable')
        identities.append({key: identity[key] for key in fields})
    return identities


def capture_sample(sample, disk_free_bytes, identities):
    """Whitelist quantitative observation fields; never echo opaque diagnostic data."""
    result = {key: sample.get(key) for key in
              ('footprintBytes', 'swapBytes', 'pressureLevel', 'freePercent')}
    result['diskFreeBytes'] = disk_free_bytes
    if not valid_sample(result):
        raise ValueError('monitoring-unavailable')
    count = sample.get('processCount', len(identities))
    if type(count) is not int or count != len(identities):
        raise ValueError('monitoring-unavailable')
    result.update(processCount=count, processes=identities)
    return result


class MilestonePolicy:
    """Accumulate intervals bracketed by critical samples, recover after 15 s.

    Warning/normal intervals do not add critical time. A short recovery retains
    the previous critical total; 15 continuous noncritical seconds resets it.
    Discrete observations cannot reconstruct pressure changes between samples.
    """
    def __init__(self, *, started):
        self.started = started
        self.previous_time = None
        self.previous_pressure = None
        self.recovery_started = None
        self.critical_seconds = 0

    def evaluate(self, sample, now):
        if (type(self.started) not in (int, float) or not math.isfinite(self.started) or
                not valid_sample(sample) or type(now) not in (int, float) or
                not math.isfinite(now) or now < self.started or
                (self.previous_time is not None and now < self.previous_time)):
            return 'monitoring-unavailable'
        if now - self.started >= TIMEOUT_SECONDS:
            return 'timeout'
        if sample['diskFreeBytes'] < MIN_DISK_BYTES:
            return 'disk-budget'
        pressure = sample['pressureLevel']
        if pressure == 4:
            if self.previous_pressure == 4:
                self.critical_seconds += now - self.previous_time
            self.recovery_started = None
        else:
            if self.recovery_started is None:
                self.recovery_started = now
            if now - self.recovery_started >= RECOVERY_SECONDS:
                self.critical_seconds = 0
        self.previous_time = now
        self.previous_pressure = pressure
        return 'sustained-critical-pressure' if self.critical_seconds >= CRITICAL_SECONDS else None
