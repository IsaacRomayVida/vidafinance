import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

function loadTemplate(name: string): HandlebarsTemplateDelegate {
  const filePath = path.join(TEMPLATES_DIR, `${name}.hbs`);
  const source = fs.readFileSync(filePath, 'utf8');
  return Handlebars.compile(source);
}

const templates = {
  contract: loadTemplate('contract'),
  receipt: loadTemplate('receipt'),
  'deduction-report': loadTemplate('deduction-report'),
  'portfolio-report': loadTemplate('portfolio-report'),
};

export type TemplateName = keyof typeof templates;

export function renderTemplate(name: TemplateName, data: Record<string, unknown>): string {
  const tpl = templates[name];
  if (!tpl) throw new Error(`Unknown template: ${name}`);
  return tpl(data);
}

export function getAvailableTemplates(): TemplateName[] {
  return Object.keys(templates) as TemplateName[];
}
