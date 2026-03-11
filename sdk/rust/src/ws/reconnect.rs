use std::time::Duration;

/// Exponential backoff strategy for WS reconnection.
///
/// Starts at `min`, doubles each time (multiplied by `factor`), caps at `max`.
/// Call `reset()` after a successful connection.
#[derive(Debug, Clone)]
pub struct ExponentialBackoff {
    current: Duration,
    min: Duration,
    max: Duration,
    factor: f64,
}

impl ExponentialBackoff {
    pub fn new(min: Duration, max: Duration, factor: f64) -> Self {
        Self {
            current: min,
            min,
            max,
            factor,
        }
    }

    /// Returns the current delay and advances to the next interval.
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.current;
        self.current = self.current.mul_f64(self.factor).min(self.max);
        delay
    }

    /// Resets the backoff to the initial delay.
    pub fn reset(&mut self) {
        self.current = self.min;
    }
}

impl Default for ExponentialBackoff {
    fn default() -> Self {
        Self::new(
            Duration::from_secs(1),
            Duration::from_secs(30),
            2.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_progression() {
        let mut b = ExponentialBackoff::default();
        assert_eq!(b.next_delay(), Duration::from_secs(1));
        assert_eq!(b.next_delay(), Duration::from_secs(2));
        assert_eq!(b.next_delay(), Duration::from_secs(4));
        assert_eq!(b.next_delay(), Duration::from_secs(8));
        assert_eq!(b.next_delay(), Duration::from_secs(16));
        // Capped at 30s
        assert_eq!(b.next_delay(), Duration::from_secs(30));
        assert_eq!(b.next_delay(), Duration::from_secs(30));
    }

    #[test]
    fn test_backoff_reset() {
        let mut b = ExponentialBackoff::default();
        b.next_delay(); // 1s
        b.next_delay(); // 2s
        b.next_delay(); // 4s
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_secs(1));
    }
}
