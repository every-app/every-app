import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { deleteHostCertificates } from "./certificates";

// The shapes Cloudflare lists in a zone with the gateway at its apex
// (everyapp.team, 2026-10-16): Universal SSL's active pack and its backup,
// the gateway's own Custom Domain pack, and one advanced pack per app.
const universal = {
  id: "universal",
  type: "universal",
  status: "active",
  hosts: ["example.com", "*.example.com"],
};
const universalBackup = {
  id: "universal-backup",
  type: "universal",
  status: "backup_issued",
  hosts: ["example.com", "*.example.com"],
};
const gateway = {
  id: "gateway",
  type: "advanced",
  status: "active",
  hosts: ["example.com", "*.example.com"],
};
const todo = {
  id: "todo",
  type: "advanced",
  status: "active",
  hosts: ["example.com", "todo.example.com", "*.todo.example.com"],
};
const chef = {
  id: "chef",
  type: "advanced",
  status: "active",
  hosts: ["example.com", "chef.example.com", "*.chef.example.com"],
};

function zoneWith(packs: object[]) {
  return new FakeCf().on(["ssl", "certificate-packs", "list"], (call) => ({
    stdout: JSON.stringify(call.args.includes("1") ? packs : []),
  }));
}

async function deleteTodo(cf: FakeCf, events: any[] = []) {
  return deleteHostCertificates({
    cf,
    out: createNdjsonSink((line) => events.push(JSON.parse(line))),
    step: "app.delete",
    zoneId: "zone-1",
    hostname: "todo.example.com",
  });
}

function deletedIds(cf: FakeCf) {
  return cf.calls
    .filter((call) => call.args[2] === "delete")
    .map((call) => call.args[3]);
}

describe("deleteHostCertificates", () => {
  it("deletes the app's pack [apex, host, *.host] when Universal SSL covers the apex, confirming cf's prompt", async () => {
    const events: any[] = [];
    const cf = zoneWith([universal, universalBackup, todo, chef]);

    await expect(deleteTodo(cf, events)).resolves.toEqual(["todo"]);
    expect(cf.calls.at(-1)!.args).toEqual([
      "ssl",
      "certificate-packs",
      "delete",
      "todo",
      "-z",
      "zone-1",
      "--force",
    ]);
    expect(deletedIds(cf)).toEqual(["todo"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "progress",
        message: "Removed todo.example.com's certificate.",
        data: { certificatePacks: ["todo"] },
      }),
    ]);
  });

  it("deletes the app's pack when the gateway's own pack covers the apex", async () => {
    const cf = zoneWith([gateway, todo]);
    await expect(deleteTodo(cf)).resolves.toEqual(["todo"]);
  });

  it("keeps the app's pack when it is the only active one covering the apex", async () => {
    const events: any[] = [];
    // Universal SSL's backup and a pack still on its way are no cover.
    const cf = zoneWith([
      universalBackup,
      { ...gateway, status: "pending_validation" },
      todo,
    ]);
    await expect(deleteTodo(cf, events)).resolves.toEqual([]);
    expect(deletedIds(cf)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("never lets two of the hostname's packs vouch for each other's apex", async () => {
    const cf = zoneWith([todo, { ...todo, id: "todo-again" }]);
    await expect(deleteTodo(cf)).resolves.toEqual(["todo"]);
  });

  it("deletes all of the hostname's packs when something else covers the apex", async () => {
    const cf = zoneWith([universal, todo, { ...todo, id: "todo-again" }]);
    await expect(deleteTodo(cf)).resolves.toEqual(["todo", "todo-again"]);
  });

  it("never deletes Universal SSL's packs, even one listing the hostname", async () => {
    const cf = zoneWith([
      gateway,
      { ...universal, hosts: ["example.com", "todo.example.com"] },
      universalBackup,
    ]);
    await expect(deleteTodo(cf)).resolves.toEqual([]);
  });

  it("never deletes another app's pack, nor one listing another app's host that no other pack lists", async () => {
    const cf = zoneWith([
      universal,
      chef,
      {
        id: "shared",
        type: "advanced",
        status: "active",
        hosts: ["todo.example.com", "workout.example.com"],
      },
    ]);
    // Universal SSL's *.example.com answers for workout, but doesn't list it.
    await expect(deleteTodo(cf)).resolves.toEqual([]);
  });

  it("never deletes a pack that covers the hostname only through a wildcard", async () => {
    const cf = zoneWith([universal, gateway]);
    await expect(deleteTodo(cf)).resolves.toEqual([]);
  });

  it("still deletes a pack listing exactly the hostname", async () => {
    const cf = zoneWith([{ id: "own", hosts: ["TODO.example.com"] }]);
    await expect(deleteTodo(cf)).resolves.toEqual(["own"]);
  });

  it("warns and deletes nothing when the packs can't be read", async () => {
    const events: any[] = [];
    const cf = new FakeCf().on(["ssl"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });
    await expect(deleteTodo(cf, events)).resolves.toEqual([]);
    expect(deletedIds(cf)).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ code: "CERT_CLEANUP_FAILED" })]);
  });
});
