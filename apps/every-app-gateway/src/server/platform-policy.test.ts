import { describe, expect, it } from "vitest";
import { describePolicy, platformPolicy } from "./platform-policy";

describe("platformPolicy", () => {
  it("reproduces today's self-hosted gateway", () => {
    expect(platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" })).toEqual({
      mode: "self_hosted",
      hosted: false,
      openSignUp: false,
      personalOrgs: false,
      requireEmailVerification: false,
      accessSignIn: true,
      setupClaim: true,
      platformOrganizationName: null,
      sharedApps: false,
      thirdPartyDeploys: false,
      thirdPartyLimits: { cpuMs: 0, subrequests: 0, durableObjectClasses: 0 },
      tenantAdminUserActions: true,
      bindingActivation: true,
      dcr: { perAddress: 20, perGateway: 200 },
      mailDaily: {
        verification: { perAddress: 10, perGateway: 1_000 },
        reset: { perAddress: 10, perGateway: 1_000 },
        invitation: { perAddress: 10, perGateway: 1_000 },
      },
    });
  });

  it("gives the hosted gateway its own rules", () => {
    expect(platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "hosted" })).toEqual({
      mode: "hosted",
      hosted: true,
      openSignUp: true,
      personalOrgs: true,
      requireEmailVerification: true,
      accessSignIn: false,
      setupClaim: true,
      platformOrganizationName: "Every App",
      sharedApps: true,
      // The launch gate: off until third-party deploys may go live.
      thirdPartyDeploys: false,
      thirdPartyLimits: {
        cpuMs: 5_000,
        subrequests: 200,
        durableObjectClasses: 2,
      },
      tenantAdminUserActions: false,
      bindingActivation: true,
      dcr: { perAddress: 200, perGateway: 20_000 },
      mailDaily: {
        verification: { perAddress: 5, perGateway: 2_000 },
        reset: { perAddress: 5, perGateway: 1_000 },
        invitation: { perAddress: 5, perGateway: 2_000 },
      },
    });
  });

  it("fails closed on a missing or mistyped mode: nothing hosted, nothing self-hosted", () => {
    for (const mode of [undefined, "", "selfhosted", "self-hosted", "prod"]) {
      const policy = platformPolicy({ GATEWAY_DEPLOYMENT_MODE: mode });
      expect(policy.mode, String(mode)).toBe("invalid");
      // Hosted-only behaviour is refused...
      expect(policy).toMatchObject({
        hosted: false,
        openSignUp: false,
        personalOrgs: false,
        sharedApps: false,
        thirdPartyDeploys: false,
      });
      // ...and so is what a self-hosted gateway does.
      expect(policy).toMatchObject({
        accessSignIn: false,
        setupClaim: false,
        tenantAdminUserActions: false,
        bindingActivation: false,
        dcr: { perAddress: 0, perGateway: 0 },
        mailDaily: {
          verification: { perAddress: 0, perGateway: 0 },
          reset: { perAddress: 0, perGateway: 0 },
          invitation: { perAddress: 0, perGateway: 0 },
        },
      });
    }
  });

  it("opens third-party deploys only on a hosted gateway whose gate is exactly on", () => {
    const gate = (mode: string, value: string | undefined) =>
      platformPolicy({
        GATEWAY_DEPLOYMENT_MODE: mode,
        THIRD_PARTY_DEPLOYS: value,
      }).thirdPartyDeploys;
    expect(gate("hosted", "on")).toBe(true);
    for (const value of [undefined, "", "true", "ON", " on", "yes", "1"]) {
      expect(gate("hosted", value), String(value)).toBe(false);
    }
    expect(gate("self_hosted", "on")).toBe(false);
    expect(gate("prod", "on")).toBe(false);
  });

  it("opens hosted sign-up unless the operator keeps the preview invite-only", () => {
    const openSignUp = (value: string | undefined) =>
      platformPolicy({
        GATEWAY_DEPLOYMENT_MODE: "hosted",
        HOSTED_OPEN_SIGNUP: value,
      }).openSignUp;
    expect(openSignUp(undefined)).toBe(true);
    expect(openSignUp("")).toBe(true);
    expect(openSignUp(" TRUE ")).toBe(true);
    expect(openSignUp("false")).toBe(false);
    // A typo closes sign-up rather than opening it.
    for (const typo of ["flase", "no", "0", "off"]) {
      expect(openSignUp(typo), typo).toBe(false);
    }
    // Nothing else changes: invitees still verify and get no personal
    // organization of their own.
    expect(
      platformPolicy({
        GATEWAY_DEPLOYMENT_MODE: "hosted",
        HOSTED_OPEN_SIGNUP: "false",
      }),
    ).toMatchObject({ personalOrgs: true, requireEmailVerification: true });
    // The switch is hosted-only: self-hosted stays invite-only.
    expect(
      platformPolicy({
        GATEWAY_DEPLOYMENT_MODE: "self_hosted",
        HOSTED_OPEN_SIGNUP: "true",
      }).openSignUp,
    ).toBe(false);
  });

  it("reads the mode as resolveDeploymentMode does: trimmed, any case", () => {
    expect(platformPolicy({ GATEWAY_DEPLOYMENT_MODE: " Hosted " }).mode).toBe(
      "hosted",
    );
    expect(
      platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "SELF_HOSTED" }).mode,
    ).toBe("self_hosted");
  });

  it("is frozen, nested objects included", () => {
    const policy = platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "hosted" });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.dcr)).toBe(true);
    expect(Object.isFrozen(policy.mailDaily)).toBe(true);
    expect(Object.isFrozen(policy.mailDaily.verification)).toBe(true);
  });
});

describe("describePolicy", () => {
  it("tells the sign-in pages how people sign up, per mode", () => {
    expect(
      describePolicy(
        platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" }),
      ),
    ).toEqual({ signUp: "invitation", emailVerification: false });
    expect(
      describePolicy(platformPolicy({ GATEWAY_DEPLOYMENT_MODE: "hosted" })),
    ).toEqual({ signUp: "open", emailVerification: true });
    expect(
      describePolicy(
        platformPolicy({
          GATEWAY_DEPLOYMENT_MODE: "hosted",
          HOSTED_OPEN_SIGNUP: "false",
        }),
      ),
    ).toEqual({ signUp: "invitation", emailVerification: true });
    expect(describePolicy(platformPolicy({}))).toEqual({
      signUp: "invitation",
      emailVerification: false,
    });
  });
});
