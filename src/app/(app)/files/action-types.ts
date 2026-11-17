/** What the file screens' server actions hand back to their forms and buttons. */

/** The result of creating a file, reported exactly as the service reported it. */
export interface CreateFileOutcome {
  fileId: string;
  reference: string;
  clientName: string;
  clientEmail: string;
  /** False when a file with the same details already existed and was returned instead. */
  created: boolean;
  agreement: {
    sent: boolean;
    emailed: boolean;
    /** Why the agreement was not sent, or was sent but not emailed. */
    reason: string | null;
    /** The client's signing link, present whenever an agreement was created. */
    signingUrl: string | null;
  };
}

/** The result of one action on an agreement: a sentence, and the link when the sender has to pass it on. */
export interface AgreementOutcome {
  message: string;
  /** "warning": it worked, but something still needs the sender (usually sharing the link by hand). */
  tone: "success" | "warning";
  signingUrl?: string | null;
}

/** After saving file details: set when the agreement already out still carries the old name or address. */
export interface UpdateFileOutcome {
  reissue: { signerId: string; name: string; email: string } | null;
}
