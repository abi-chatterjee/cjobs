export function openLogSocket(jobName) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${location.host}/ws/logs/${encodeURIComponent(jobName)}`);
}

export function openDoctorSocket(quick) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const qs = quick ? "?quick=1" : "";
  return new WebSocket(`${proto}//${location.host}/ws/doctor${qs}`);
}
