/**
 * Main-thread side of X-Ray. This module (and the worker it starts) is imported dynamically the
 * first time X-Ray is used, so normal reading never parses or runs any of it.
 */
import type { PageEntity } from '../../types';
import type { ExtractedEntity, XrayRequest, XrayResponse } from '../../workers/xrayWorker';

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (r: XrayResponse) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/xrayWorker.ts', import.meta.url), { type: 'module', name: 'xray' });
  worker.onmessage = (e: MessageEvent<XrayResponse>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (!w) return;
    if (e.data.type === 'error') w.reject(new Error(e.data.message));
    else w.resolve(e.data);
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'X-Ray worker failed'));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function send(req: WithoutId<XrayRequest>): Promise<XrayResponse> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ ...req, id });
  });
}

/** Entities on one page, most mentioned first. */
export async function extractPage(text: string): Promise<PageEntity[]> {
  const r = await send({ type: 'page', text });
  if (r.type !== 'page') return [];
  return r.entities.slice(0, 40).map(({ label, kind, count }) => ({ label, kind, count }));
}

export async function extractPages(pages: Array<{ page: number; text: string }>) {
  const r = await send({ type: 'pages', pages });
  return r.type === 'pages' ? r.pages : [];
}

export type { ExtractedEntity };
