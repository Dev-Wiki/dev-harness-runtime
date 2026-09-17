import { Registry } from "@dev-harness-runtime/core";

/** Metadata registration only; this class does not package build targets. */
export class BuildRegistry<T extends { readonly id: string }> extends Registry<T> {
  constructor() {
    super("Build registry");
  }
}
