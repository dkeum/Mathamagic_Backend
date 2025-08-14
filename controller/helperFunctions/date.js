function getCurrentWeekRangeUTC() {
  const today = new Date();
  const day = today.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((day + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  return { monday, sunday };
}

function calculateWeeklyGoal(time_logged, timeCommitment) {
  const { monday, sunday } = getCurrentWeekRangeUTC();

  const weekTimes = time_logged
    .map(t => new Date(t))
    .filter(t => t >= monday && t <= sunday)
    .sort((a, b) => a - b);

  let totalHours = 0;
  for (let i = 0; i < weekTimes.length; i += 2) {
    const end = weekTimes[i + 1] || new Date(); // handle odd number of timestamps
    totalHours += (end - weekTimes[i]) / (1000 * 60 * 60);
  }

  let time_goal_met = Math.min(100, Math.round((totalHours / timeCommitment) * 100));
  return { totalHours, time_goal_met };
}


module.exports = {
    calculateWeeklyGoal
}