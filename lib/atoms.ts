import { useCallback, useEffect, useState } from "react";
import { BehaviorSubject } from "./core";

export type Atom<T, S = T> = {
  subject: BehaviorSubject<T>;
  update: (value: S) => Promise<void>;
};

type Concurrency = "synchronous" | ConcurrencyNoSync;
type ConcurrencyNoSync = "queue" | "throttle" | "debounce";
export function atom<T, S = T, U = T>({
  initialValue,
  persistKey,
  persistLayer,
  update,
  appVersion,
  transformOnDeserialize,
  transformOnSerialize,
  equalityCompareFn,
  concurrency,
  concurrencyTime,
}: {
  initialValue: T;
  persistKey?: string;
  persistLayer?: "local" | "session";
  update?: (state: T, value: S) => T;
  appVersion?: string;
  transformOnSerialize?: (obj: T) => U | Promise<U>;
  transformOnDeserialize?: (obj: U) => T | Promise<T>;
  equalityCompareFn?: (newValue: T, oldValue?: T) => boolean;
  concurrency: "synchronous";
  concurrencyTime?: number;
}): Atom<T, S>;
export function atom<T, S = T, U = T>({
  initialValue,
  persistKey,
  persistLayer,
  update,
  appVersion,
  transformOnDeserialize,
  transformOnSerialize,
  equalityCompareFn,
  concurrency,
  concurrencyTime,
}: {
  initialValue: T;
  persistKey?: string;
  persistLayer?: "local" | "session";
  update?: (state: T, value: S) => Promise<T> | T;
  appVersion?: string;
  transformOnSerialize?: (obj: T) => U | Promise<U>;
  transformOnDeserialize?: (obj: U) => T | Promise<T>;
  equalityCompareFn?: (newValue: T, oldValue?: T) => boolean;
  concurrency: ConcurrencyNoSync;
  concurrencyTime?: number;
}): Atom<T, S>;
export function atom<T, S = T, U = T>({
  initialValue,
  persistKey,
  persistLayer,
  update,
  appVersion,
  transformOnDeserialize,
  transformOnSerialize,
  equalityCompareFn,
  concurrency,
  concurrencyTime,
}: {
  initialValue: T;
  persistKey?: string;
  persistLayer?: "local" | "session";
  update?: (state: T, value: S) => T;
  appVersion?: string;
  transformOnSerialize?: (obj: T) => U | Promise<U>;
  transformOnDeserialize?: (obj: U) => T | Promise<T>;
  equalityCompareFn?: (newValue: T, oldValue?: T) => boolean;
  concurrency?: undefined;
  concurrencyTime?: number;
}): Atom<T, S>;
export function atom<T, S = T, U = T>({
  initialValue,
  persistKey,
  persistLayer = "local",
  update,
  appVersion,
  transformOnDeserialize,
  transformOnSerialize,
  equalityCompareFn,
  concurrency = "synchronous",
  concurrencyTime = Number.MAX_SAFE_INTEGER,
}: {
  initialValue: T;
  persistKey?: string;
  persistLayer?: "local" | "session";
  update?: (state: T, value: S) => Promise<T> | T;
  appVersion?: string;
  transformOnSerialize?: (obj: T) => U | Promise<U>;
  transformOnDeserialize?: (obj: U) => T | Promise<T>;
  equalityCompareFn?: (newValue: T, oldValue?: T) => boolean;
  concurrency?: Concurrency;
  concurrencyTime?: number;
}): Atom<T, S> {
  const subject = new BehaviorSubject<T>(initialValue, {
    equalityCompareFn,
  });

  const updatesWhileDeserializing: S[] = [];
  let initPersistanceIsRunning = false;

  if (persistKey) {
    const storage = persistLayer === 'local' ? localStorage : sessionStorage;
    // Load from storage after the atom is created
    const storedJson = JSON.parse(storage.getItem(persistKey) ?? "{}");

    // Remove from storage if version has been updated
    if (storedJson.version !== appVersion) {
      storage.removeItem(persistKey);
    } else if (transformOnDeserialize && storedJson.data) {
      let deserialized = transformOnDeserialize(storedJson.data);
      if (isPromise(deserialized)) {
        initPersistanceIsRunning = true;
        deserialized.then(async (value) => {
          subject.next(value);
          initPersistanceIsRunning = false;
          await Promise.all(
            updatesWhileDeserializing.map(async (updatedValue) => {
              const newValue = !update ? (updatedValue as unknown as T) :
                concurrency === "synchronous" ? update(subject.value, updatedValue) :
                await update(subject.value, updatedValue);

              subject.next(newValue as T);
            }),
          );
        });
      } else {
        subject.next(deserialized);
      }
    } else if (storedJson?.data !== undefined) {
      subject.next(storedJson.data);
    }

    // Automatically save to storage when the atom changes
    subject.pipe((value: T) => {
      (async () => {
        let data: T | U | Promise<T | U> = value;
        if (initPersistanceIsRunning) return;
        if (transformOnSerialize) {
          data = transformOnSerialize(value);
          if (isPromise(data)) {
            data = await data;
          }
        }
        storage.setItem(
          persistKey,
          JSON.stringify({ data, version: appVersion }),
        );
      })();
      return { value, stopPropagation: true };
    });
  }

  let idgen = 0;
  // Handle updates to the atom, taking in to account concurrency rules
  // Default is synchronous, which means every update is processed immediately without queing
  // Queue means all updates are processed in order
  // Throttle means only the first update is processed, and the rest are ignored
  // Debounce means only the last update is processed, and the rest are ignored
  const updateFunction = async (value: S) => {
    if (initPersistanceIsRunning) {
      updatesWhileDeserializing.push(value as S);
      return;
    }

    if (
      updateFunction.queue.length > 0 &&
      concurrency === "throttle" &&
      Date.now() - updateFunction.queue[0].timestamp <= concurrencyTime
    ) {
      return;
    }

    let resolver = (a: any) => a;
    const updatePromise = new Promise<any>((res) => {
      resolver = res;
    });

    if (concurrency === "debounce") {
      updateFunction.queue.forEach((x) => {
        if (Date.now() - x.timestamp < concurrencyTime) x.skip = true;
      });
      updateFunction.queue = [];
    }

    const id = idgen++;
    const queueItem = {
      id,
      updatePromise,
      skip: false,
      timestamp: Date.now(),
    };

    if(concurrency !== "synchronous") {
      updateFunction.queue.push(queueItem);
    }

    if (concurrency === "queue") {
      await Promise.all(
        updateFunction.queue.slice(0, -1).map((x) => x.updatePromise),
      );
    }

    const newValue = !update ? (value as unknown as T) :
      concurrency === "synchronous" ? update(subject.value, value) :
      await update(subject.value, value);

    if (concurrency === "debounce" && queueItem.skip) {
      return;
    }

    subject.next(newValue as T);

    if(concurrency !== "synchronous") {
      updateFunction.queue.splice(
        updateFunction.queue.findIndex((x) => x.id === id),
        1,
      );
    }
    resolver(newValue);
  };

  updateFunction.queue = [] as {
    id: number;
    updatePromise: Promise<T>;
    skip?: boolean;
    timestamp: number;
  }[];

  return { subject, update: updateFunction };
}

export function useAtom<T, S = T>(atom: Atom<T, S>): [T, (value: S) => void] {
  const [data, setData] = useState<T>(atom.subject.value);

  const update = useCallback((value: S) => atom.update(value), []);

  useEffect(() => {
    return atom.subject.subscribe(setData);
  }, []);

  return [data, update];
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value &&
    typeof value === "object" &&
    typeof (value as any).then === "function"
  );
}
