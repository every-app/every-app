// The SDK's `EveryAppManifest` (what `defineEveryApp` in @every-app/sdk
// types an app's everyapp.config.ts with) is written by hand, since the SDK
// can't import this schema. These checks hold the two together: a field
// added to the schema fails here until the SDK's type has it too.
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { EveryAppManifest as SdkManifest } from "@every-app/sdk";
import type { ManifestSchemaStrict } from "./manifest";

type SchemaInput = z.input<typeof ManifestSchemaStrict>;
/** The SDK's type is readonly throughout, so `as const` manifests pass. */
type Writable<T> = T extends (infer E)[]
  ? Writable<E>[]
  : T extends readonly (infer E)[]
    ? Writable<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: Writable<T[K]> }
      : T;
type Resources = NonNullable<SchemaInput["resources"]>;
type SdkResources = NonNullable<SdkManifest["resources"]>;

describe("the SDK's EveryAppManifest", () => {
  it("has every field of the manifest schema, and no other", () => {
    expectTypeOf<keyof SdkManifest>().toEqualTypeOf<keyof SchemaInput>();
    expectTypeOf<keyof SdkResources>().toEqualTypeOf<keyof Resources>();
  });

  it("is accepted where the schema's input is", () => {
    const accepts = (manifest: Writable<SdkManifest>): SchemaInput => manifest;
    void accepts;
  });
});
