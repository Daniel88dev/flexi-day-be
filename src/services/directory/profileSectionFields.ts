/** Field names as the API and the profile history spell them, per Section. */
export const CARD_COLUMNS = { jobTitle: "jobTitle", reportsToEmploymentId: "reportsTo" } as const;
export const WORK_CONTACT_COLUMNS = { workEmail: "workEmail", workPhone: "workPhone" } as const;
export const JOB_COLUMNS = {
  legalName: "legalName",
  employeeNumber: "employeeNumber",
  startDate: "startDate",
  leavingDate: "leavingDate",
  probationEndDate: "probationEndDate",
  contractType: "contractType",
  workingTime: "workingTime",
} as const;

/** The fields of the sealed Sections, as the history names them. */
export const CONTACT_FIELDS = [
  "privatePhone",
  "privateEmail",
  "emergencyContact1",
  "emergencyContact2",
] as const;
export const PERSONAL_FIELDS = ["homeAddress", "dateOfBirth"] as const;
export const PHOTO_FIELDS = ["photo"] as const;
