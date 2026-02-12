import type { Detector } from "../types";
import {
  MissingSignerCheck,
  MissingOwnerCheck,
  PDADerivationMistake,
  ArbitraryCPITarget,
  TypeConfusion,
} from "./detectors-01-05";
import {
  Reinitialization,
  CloseThenRevive,
  UncheckedRealloc,
  IntegerOverflow,
  StateMachineViolation,
} from "./detectors-06-10";
import {
  RemainingAccountsInjection,
  OracleValidationFailure,
  TokenAccountMismatch,
  PostCPIStaleRead,
  DuplicateAccountInjection,
} from "./detectors-11-15";

export const ALL_DETECTORS: Detector[] = [
  MissingSignerCheck,
  MissingOwnerCheck,
  PDADerivationMistake,
  ArbitraryCPITarget,
  TypeConfusion,
  Reinitialization,
  CloseThenRevive,
  UncheckedRealloc,
  IntegerOverflow,
  StateMachineViolation,
  RemainingAccountsInjection,
  OracleValidationFailure,
  TokenAccountMismatch,
  PostCPIStaleRead,
  DuplicateAccountInjection,
];

export {
  MissingSignerCheck,
  MissingOwnerCheck,
  PDADerivationMistake,
  ArbitraryCPITarget,
  TypeConfusion,
  Reinitialization,
  CloseThenRevive,
  UncheckedRealloc,
  IntegerOverflow,
  StateMachineViolation,
  RemainingAccountsInjection,
  OracleValidationFailure,
  TokenAccountMismatch,
  PostCPIStaleRead,
  DuplicateAccountInjection,
};
