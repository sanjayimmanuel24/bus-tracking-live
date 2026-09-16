/**
 * Service alert chips.
 *
 * Every chip corresponds to a `ServiceAlert` produced from actual simulation
 * state -- a specific vehicle held up near a specific stop. The prototype picked
 * strings at random from a fixed list, so an alert never corresponded to anything
 * visible on the map and could not be acted on.
 */

import type { ServiceAlert } from '@citybus/shared';

export class AlertStack {
  private readonly container: HTMLElement;
  private readonly rendered = new Map<string, HTMLElement>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  render(alerts: ServiceAlert[]): void {
    const seen = new Set<string>();

    for (const alert of alerts) {
      seen.add(alert.id);
      if (this.rendered.has(alert.id)) continue;

      const chip = document.createElement('div');
      chip.className = 'alert-chip';
      chip.dataset['severity'] = alert.severityLevel.toLowerCase();
      chip.setAttribute('role', 'status');

      const icon = document.createElement('span');
      icon.className = 'alert-chip__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '!';

      const text = document.createElement('span');
      text.textContent = alert.headerText;

      chip.append(icon, text);
      this.container.append(chip);
      this.rendered.set(alert.id, chip);
    }

    for (const [id, el] of this.rendered) {
      if (seen.has(id)) continue;
      el.classList.add('is-leaving');
      // Let the exit transition finish before detaching.
      window.setTimeout(() => el.remove(), 300);
      this.rendered.delete(id);
    }
  }
}
