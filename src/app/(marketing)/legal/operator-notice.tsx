/**
 * The box at the top of the terms and the privacy notice. These pages ship as
 * honest starting documents: the product cannot know who operates a given
 * deployment, so the notice says exactly what the operator still has to supply
 * rather than leaving blanks in the text or inventing a company.
 */
export function OperatorNotice({ document }: { document: "terms" | "privacy notice" }) {
  return (
    <>
      <p>
        <strong>This is a starting document, not a finished one.</strong> It was written in plain language to describe how the
        service works and has not been reviewed by a lawyer.
      </p>
      <p className="mt-2">
        Whoever operates this deployment should have counsel review these {document === "terms" ? "terms" : "pages"} and add what
        only they can supply: the operator&rsquo;s legal name and contact address, the governing law
        {document === "terms" ? ", and any fees and service commitments" : ", the hosting region, and how to make a data request"}.
        Until that is done, treat this {document} as a description, not a contract.
      </p>
    </>
  );
}
