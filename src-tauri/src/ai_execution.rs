use crate::engine::Result;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

#[derive(Default)]
struct State {
    active: Option<(u64, String)>,
    waiting: VecDeque<(u64, String)>,
    sequence: u64,
    closing: bool,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

/// A single device budget is shared by every inference provider. Downloading
/// and reading status never reserve that budget.
#[derive(Clone, Default)]
pub struct AiExecutionGate {
    shared: Arc<Shared>,
}
pub struct AiExecutionPermit {
    shared: Arc<Shared>,
    ticket: u64,
}

impl AiExecutionGate {
    pub fn acquire(
        &self,
        id: &str,
        cancelled: &AtomicBool,
        on_wait: impl FnOnce(&str),
    ) -> Result<AiExecutionPermit> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "AI 任务调度状态不可用。")?;
        if state.closing {
            cancelled.store(true, Ordering::SeqCst);
        }
        if state.closing || cancelled.load(Ordering::SeqCst) {
            return Err("AI 任务已取消。".into());
        }
        state.sequence = state
            .sequence
            .checked_add(1)
            .ok_or("AI 任务数量超出限制。")?;
        let ticket = state.sequence;
        let blocker = state
            .active
            .as_ref()
            .or_else(|| state.waiting.front())
            .map(|(_, id)| id.clone());
        state.waiting.push_back((ticket, id.to_owned()));
        if let Some(blocker) = blocker {
            drop(state);
            on_wait(&blocker);
            state = self
                .shared
                .state
                .lock()
                .map_err(|_| "AI 任务调度状态不可用。")?;
        }
        loop {
            if state.closing {
                cancelled.store(true, Ordering::SeqCst);
            }
            if state.closing || cancelled.load(Ordering::SeqCst) {
                state.waiting.retain(|(queued, _)| *queued != ticket);
                self.shared.changed.notify_all();
                return Err("AI 任务已取消。".into());
            }
            if state.active.is_none()
                && state
                    .waiting
                    .front()
                    .is_some_and(|(queued, _)| *queued == ticket)
            {
                state.waiting.pop_front();
                state.active = Some((ticket, id.to_owned()));
                return Ok(AiExecutionPermit {
                    shared: self.shared.clone(),
                    ticket,
                });
            }
            state = self
                .shared
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .map_err(|_| "AI 任务调度状态不可用。")?
                .0;
        }
    }
    pub fn shutdown(&self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.closing = true;
            self.shared.changed.notify_all();
        }
    }
}
impl Drop for AiExecutionPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|(ticket, _)| *ticket == self.ticket)
            {
                state.active = None;
                self.shared.changed.notify_all();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Instant};
    #[test]
    fn providers_wait_for_the_device_and_release_it() {
        let gate = AiExecutionGate::default();
        let first = gate
            .acquire("speech:a", &AtomicBool::new(false), |_| {
                panic!("unexpected wait")
            })
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let next = gate.clone();
        let task = thread::spawn(move || {
            let permit = next
                .acquire("image:b", &AtomicBool::new(false), |id| {
                    tx.send(id.to_string()).unwrap()
                })
                .unwrap();
            tx.send("started".into()).unwrap();
            drop(permit);
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "speech:a");
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "started");
        task.join().unwrap();
        assert!(gate
            .acquire("video:c", &AtomicBool::new(false), |_| {})
            .is_ok());
    }
    #[test]
    fn cancelling_a_queued_job_does_not_wait_for_the_active_job() {
        let gate = AiExecutionGate::default();
        let _first = gate
            .acquire("video:a", &AtomicBool::new(false), |_| {})
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let next = gate.clone();
        let (tx, rx) = mpsc::channel();
        let task = thread::spawn(move || {
            next.acquire("music:b", &flag, |_| tx.send(()).unwrap())
                .map(|_| ())
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let began = Instant::now();
        cancelled.store(true, Ordering::SeqCst);
        assert!(task.join().unwrap().is_err());
        assert!(began.elapsed() < Duration::from_secs(2));
        gate.shutdown();
        assert!(gate
            .acquire("image:c", &AtomicBool::new(false), |_| {})
            .is_err());
    }

    #[test]
    fn shutdown_marks_waiting_jobs_as_cancelled() {
        let gate = AiExecutionGate::default();
        let _first = gate
            .acquire("speech:first", &AtomicBool::new(false), |_| {})
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let next = gate.clone();
        let (tx, rx) = mpsc::channel();
        let task = thread::spawn(move || {
            next.acquire("image:waiting", &flag, |_| tx.send(()).unwrap())
                .map(|_| ())
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        gate.shutdown();
        assert!(task.join().unwrap().is_err());
        assert!(cancelled.load(Ordering::SeqCst));
    }
}
