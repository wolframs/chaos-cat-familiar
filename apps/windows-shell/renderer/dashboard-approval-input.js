export function dashboardApprovalSubmission(approval, draft = {}) {
  const questions = approval.event?.toolInput?.questions;
  if (Array.isArray(questions) && questions.length) {
    const answers = {};
    for (const question of questions) {
      const answer = String(draft.answers?.[question.question] ?? "").trim();
      if (!answer) throw new Error("Answer each question before sending.");
      answers[question.question] = answer;
    }
    return { id: approval.id, action: "allowWithAnswers", payload: { answers } };
  }
  const feedback = String(draft.feedback ?? "").trim();
  if (approval.event?.toolName === "ExitPlanMode" && feedback) {
    return { id: approval.id, action: "allowWithFeedback", payload: { feedback } };
  }
  return { id: approval.id, action: "allow" };
}
