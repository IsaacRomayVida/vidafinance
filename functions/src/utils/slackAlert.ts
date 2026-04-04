export async function sendSlackAlert(message: string, severity: 'info' | 'warning' | 'critical' = 'info') {
  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  if (!webhookUrl) return;

  const emoji = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '🔵';
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${emoji} *VIDA ${severity.toUpperCase()}*: ${message}`,
    }),
  }).catch(() => {});
}
