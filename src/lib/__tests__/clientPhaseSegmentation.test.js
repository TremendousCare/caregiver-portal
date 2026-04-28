import { describe, expect, it } from 'vitest';
import { isClientPipelinePhase, PIPELINE_PHASE_IDS } from '../../features/clients/utils';

describe('client phase segmentation', () => {
  it('marks pipeline phases as pipeline', () => {
    for (const phaseId of PIPELINE_PHASE_IDS) {
      expect(isClientPipelinePhase(phaseId)).toBe(true);
    }
  });

  it('does not mark terminal/status phases as pipeline', () => {
    expect(isClientPipelinePhase('won')).toBe(false);
    expect(isClientPipelinePhase('lost')).toBe(false);
    expect(isClientPipelinePhase('nurture')).toBe(false);
  });
});
