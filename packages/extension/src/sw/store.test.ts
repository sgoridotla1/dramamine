import 'fake-indexeddb/auto';
import { sampleRecording } from '../../../shared/src/test-samples';
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from './store';

beforeEach(async () => {
  for (const r of await store.listRecordings()) await store.deleteRecording(r.id);
});

describe('recording store', () => {
  it('saves, lists and gets a recording with its images', async () => {
    const rec = sampleRecording();
    await store.saveRecording(rec, { blob_r1: 'cmVnaW9u', blob_v1: 'dmlld3BvcnQ=' });

    expect(await store.listRecordings()).toEqual([expect.objectContaining({ id: 'rec_1', title: 'Cart total shows $0', stepCount: 2, checkpointCount: 1 })]);
    expect(await store.getRecording('rec_1')).toEqual(rec);
    expect(await store.getImages(store.imageIds(rec))).toEqual({ blob_r1: 'cmVnaW9u', blob_v1: 'dmlld3BvcnQ=' });
  });

  it('lists newest first', async () => {
    await store.saveRecording({ ...sampleRecording(), id: 'old', startedAt: 1 }, {});
    await store.saveRecording({ ...sampleRecording(), id: 'new', startedAt: 2 }, {});
    expect((await store.listRecordings()).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('renames in both the summary and the recording', async () => {
    await store.saveRecording(sampleRecording(), {});
    expect(await store.renameRecording('rec_1', 'Total is wrong')).toBe(true);
    expect((await store.listRecordings())[0]!.title).toBe('Total is wrong');
    expect((await store.getRecording('rec_1'))!.title).toBe('Total is wrong');
    expect(await store.renameRecording('missing', 'x')).toBe(false);
  });

  it('deletes the recording and its images', async () => {
    const rec = sampleRecording();
    await store.saveRecording(rec, { blob_r1: 'a', blob_v1: 'b' });
    await store.deleteRecording('rec_1');
    expect(await store.listRecordings()).toEqual([]);
    expect(await store.getRecording('rec_1')).toBeUndefined();
    expect(await store.getImages(store.imageIds(rec))).toEqual({});
  });
});
