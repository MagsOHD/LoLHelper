import { describe, expect, it } from 'vitest';
import script from '../../../companion/lolhelper-draft.ps1?raw';
import publicScript from '../../../public/companion/lolhelper-draft.ps1?raw';
import { COMPANION_VERSION } from './CompanionHelp';

describe('companion version', () => {
  it('matches the version announced by the PowerShell script (download cache-busting)', () => {
    for (const s of [script, publicScript]) expect(s).toContain(`$script:CompanionVersion = '${COMPANION_VERSION}'`);
  });
});
