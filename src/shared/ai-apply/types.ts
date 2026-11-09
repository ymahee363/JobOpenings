/**
 * Shapes shared by the AI apply flow, the form engine and the LLM backend (backend/app/main.py). Ported from
 * job-apply-ai-mvp (extension/src/api/client.ts); field names are snake_case because the backend's pydantic models
 * use them.
 */

export interface CustomField {
  id: string;
  name: string;
  value: string;
}

/** One job in the work history, most recent first: the order fills a repeatable "+ Add" experience section. */
export interface ExperienceEntry {
  title: string;
  company: string;
  location: string;
  start_date: string;
  end_date: string;
  current: boolean;
  description: string;
}

export interface CandidateProfile {
  name: string;
  email: string;
  phone: string;
  location: string;
  /** Annual, in rupees. */
  current_ctc?: number;
  expected_ctc?: number;
  notice_period: string;
  education: Array<Record<string, unknown>>;
  experience: ExperienceEntry[];
  skills: string[];
  linkedin?: string;
  portfolio?: string;
  /** Your own question/answer facts ("Work authorization: Indian citizen"), matched by name to form questions. */
  custom_fields: CustomField[];
  /** Free text for open-ended questions: a career gap, a project, awards. Sent to the LLM as context. */
  extra_information: string;
  additional_facts: Record<string, unknown>;
}

export interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  current_value: string;
  /** Radio and checkbox groups. */
  group_name?: string;
  group_label?: string;
  /** In a block the engine added with a section's "+ Add": which experience/education entry (0 = most recent). */
  entry_type?: string;
  entry_index?: number;
  /** Number, range, slider, date bounds and step, as the page states them (src/shared/ai-apply/input-kinds.ts). */
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
  /** A text box's maxlength: a 10-long phone box wants the number without its country code. */
  max_length?: string;
  /** A phone box with its own country-code picker next to it (intl-tel-input, a "+91" dropdown). */
  has_code_picker?: boolean;
  /** How the answer must be written for this control, for the LLM (set by `withKindHint`). */
  hint?: string;
}

export interface Answer {
  field_id: string;
  answer: string;
  confidence: number;
  /** existing | direct | memory | bank | profile | ai_generated | ... */
  source: string;
  needs_user_input: boolean;
}

/** What the form engine's EXTRACT_FORM returns for one frame. */
export interface FormData {
  url: string;
  title: string;
  page_text: string;
  fields: FormField[];
}

export type FrameFormData = FormData & { frameId: number };
