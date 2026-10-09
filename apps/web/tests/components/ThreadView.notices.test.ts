import { describe, expect, it } from 'vitest';
import { blockedTurnNotice } from '../../src/components/chat/ThreadView';

describe('ThreadView blocked turn notices', () => {
  it('does not turn internal completion verification into a post-answer user warning', () => {
    expect(blockedTurnNotice('Blocked by verification: acceptance verification is incomplete.')).toBeNull();
  });

  it('keeps genuinely actionable runtime and paused-work notices', () => {
    expect(blockedTurnNotice('Provider quota exhausted')).toMatchObject({
      title: 'Runtime unavailable', action: 'Retry',
    });
    expect(blockedTurnNotice('Credential approval required')).toMatchObject({
      title: 'Work paused', action: 'Resume',
    });
  });
});
