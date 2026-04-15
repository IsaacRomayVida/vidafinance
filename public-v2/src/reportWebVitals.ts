import type { Metric } from 'web-vitals';

function sendToAnalytics(metric: Metric) {
  // Log to console in development for debugging
  if (import.meta.env.DEV) {
    console.log(`[Web Vitals] ${metric.name}: ${metric.value.toFixed(1)}ms (${metric.rating})`);
  }
}

export function reportWebVitals() {
  import('web-vitals').then(({ onCLS, onLCP, onINP, onTTFB }) => {
    onCLS(sendToAnalytics);
    onLCP(sendToAnalytics);
    onINP(sendToAnalytics);
    onTTFB(sendToAnalytics);
  });
}
