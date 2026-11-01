import type {
  EmailRoutingRule,
  EmailRoutingRuleBody,
  EmailRoutingSettings,
} from "./email-types";
import type { InstallationDatabase, InstallationError } from "./error";
export type Confirm = (
  question: string,
  context?: readonly string[],
) => Promise<boolean>;
export interface Zone {
  id: string;
  name: string;
}
export interface EmailOperations<C> {
  Error: new (
    code: string,
    message: string,
    options?: InstallationError["options"],
  ) => Error & { code: string };
  CLI: string;
  confirmAtTerminal: Confirm;
  confirmOrCancel(
    asker: Confirm,
    question: string,
    options?: { context?: readonly string[]; cancelled?: string },
  ): Promise<void>;
  isCfError(error: unknown, kind: "not_found"): boolean;
  appIdOfWorker(
    db: InstallationDatabase,
    worker: string,
  ): Promise<string | null>;
  resolveZone(cf: C, host: string, account: string): Promise<Zone>;
  dnsRecordsAt(
    cf: C,
    zone: string,
    name: string,
  ): Promise<Array<{ type: string; content?: string | null }>>;
  getEmailRoutingSettings(cf: C, zone: string): Promise<EmailRoutingSettings>;
  enableEmailRouting(cf: C, zone: string, domain: string): Promise<void>;
  listEmailRoutingRules(cf: C, zone: string): Promise<EmailRoutingRule[]>;
  getEmailRoutingRule(
    cf: C,
    zone: string,
    id: string,
  ): Promise<EmailRoutingRule | null>;
  getEmailRoutingCatchAll(cf: C, zone: string): Promise<EmailRoutingRule>;
  createEmailRoutingRule(
    cf: C,
    zone: string,
    rule: EmailRoutingRuleBody,
  ): Promise<string>;
  updateEmailRoutingRule(
    cf: C,
    zone: string,
    id: string,
    rule: EmailRoutingRuleBody,
  ): Promise<void>;
  deleteEmailRoutingRule(cf: C, zone: string, id: string): Promise<boolean>;
  updateEmailRoutingCatchAll(
    cf: C,
    zone: string,
    rule: EmailRoutingRuleBody,
  ): Promise<void>;
}
