// ─────────────────────────────────────────
//  Designer-style Report Generator
//  Generates human-friendly Russian reports
// ─────────────────────────────────────────

/**
 * Generate a designer's commentary in Russian
 * Reads like a message from a designer to a developer
 */
export function generateDesignerReport(issues, options = {}) {
  const { pageName, figmaUrl, siteUrl } = options;

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const total = issues.length;

  // Group by type
  const groups = {};
  for (const i of issues) {
    if (!groups[i.type]) groups[i.type] = [];
    groups[i.type].push(i);
  }

  // ── Opening ──
  let text = '';
  if (pageName) text += `📋 Ревью страницы: ${pageName}\n`;
  if (siteUrl) text += `🔗 ${siteUrl}\n`;
  if (figmaUrl) text += `🎨 ${figmaUrl}\n`;
  if (pageName || siteUrl || figmaUrl) text += '\n';

  if (total === 0) {
    text += 'Привет! Посмотрела вёрстку — всё супер, прям один в один с макетом, красавчики! 🎉\n';
    return text;
  }

  if (errors.length === 0 && total <= 3) {
    text += 'Привет! В целом вёрстка очень близка к макету, но есть пара мелочей:\n\n';
  } else if (errors.length === 0) {
    text += 'Привет! Вёрстка хорошая, но нашла несколько расхождений с макетом — давайте подправим:\n\n';
  } else if (errors.length <= 3) {
    text += 'Привет! Посмотрела вёрстку и нашла заметные отличия от макета. Вот что нужно поправить:\n\n';
  } else {
    text += 'Привет! Вёрстка пока сильно отличается от макета, давайте пройдёмся по основным моментам:\n\n';
  }

  // ── Typography ──
  if (groups.typography) {
    text += '📝 Типографика:\n';
    for (const i of groups.typography.slice(0, 8)) {
      const hint = i.text ? ` (текст «${i.text.slice(0, 40)}»)` : '';
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}${hint}: макет ${i.expected}, сайт ${i.actual}\n`;
    }
    if (groups.typography.length > 8) text += `  ...и ещё ${groups.typography.length - 8} замечаний\n`;
    text += '\n';
  }

  // ── Spacing ──
  if (groups.spacing) {
    text += '📐 Отступы и расстояния:\n';
    for (const i of groups.spacing.slice(0, 8)) {
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}: макет ${i.expected}, сайт ${i.actual}`;
      if (i.figmaNode) text += ` [${i.figmaNode}]`;
      text += '\n';
    }
    if (groups.spacing.length > 8) text += `  ...и ещё ${groups.spacing.length - 8} замечаний\n`;
    text += '\n';
  }

  // ── Colors ──
  if (groups.color) {
    text += '🎨 Цвета:\n';
    for (const i of groups.color.slice(0, 6)) {
      const hint = i.text ? ` у «${i.text.slice(0, 40)}»` : (i.figmaNode ? ` [${i.figmaNode}]` : '');
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}${hint}: макет ${i.expected}, сайт ${i.actual}\n`;
    }
    if (groups.color.length > 6) text += `  ...и ещё ${groups.color.length - 6} расхождений\n`;
    text += '\n';
  }

  // ── Layout ──
  if (groups.layout) {
    text += '📦 Расположение:\n';
    for (const i of groups.layout.slice(0, 5)) {
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}: макет ${i.expected}, сайт ${i.actual}`;
      if (i.figmaNode) text += ` [${i.figmaNode}]`;
      text += '\n';
    }
    text += '\n';
  }

  // ── Sizing ──
  if (groups.sizing) {
    text += '📏 Размеры:\n';
    for (const i of groups.sizing.slice(0, 5)) {
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}: макет ${i.expected}, сайт ${i.actual}`;
      if (i.figmaNode) text += ` [${i.figmaNode}]`;
      text += '\n';
    }
    if (groups.sizing.length > 5) text += `  ...и ещё ${groups.sizing.length - 5}\n`;
    text += '\n';
  }

  // ── Styling ──
  if (groups.styling) {
    text += '✨ Стилизация:\n';
    for (const i of groups.styling.slice(0, 5)) {
      text += `  ${severityIcon(i.severity)} ${propertyNameRu(i.property)}: макет ${i.expected}, сайт ${i.actual}`;
      if (i.figmaNode) text += ` [${i.figmaNode}]`;
      text += '\n';
    }
    text += '\n';
  }

  // ── Content ──
  if (groups.content) {
    text += '📄 Контент:\n';
    for (const i of groups.content.slice(0, 5)) {
      text += `  ${severityIcon(i.severity)} ${i.message}\n`;
    }
    text += '\n';
  }

  // ── Summary ──
  text += '─────────────────────────────\n';
  if (errors.length > 0 && warnings.length > 0) {
    text += `Итого: ${errors.length} критичных и ${warnings.length} мелких замечаний. Давайте сначала критичные поправим, а потом мелочи подтянем!\n`;
  } else if (errors.length > 0) {
    text += `${errors.length} критичных моментов — их бы в первую очередь поправить.\n`;
  } else {
    text += `${total} некритичных замечаний — будет классно подправить, станет pixel perfect!\n`;
  }

  return text;
}

/**
 * Generate a structured JSON report
 */
export function generateStructuredReport(issues, figmaTokens, siteElements) {
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;

  const typeCounts = {};
  for (const i of issues) {
    typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
  }

  return {
    summary: {
      totalIssues: issues.length,
      errors,
      warnings,
      figmaElements: figmaTokens.length,
      siteElements: siteElements.length,
      issuesByType: typeCounts,
    },
    issues,
  };
}

// ─── Helpers ───

function severityIcon(s) {
  return { error: '🔴', warning: '🟡', info: '🔵' }[s] || '⚪';
}

function propertyNameRu(prop) {
  const map = {
    'font-size': 'Размер шрифта',
    'font-weight': 'Начертание',
    'line-height': 'Межстрочный интервал',
    'letter-spacing': 'Межбуквенное расстояние',
    'text-align': 'Выравнивание',
    'color': 'Цвет текста',
    'background-color': 'Цвет фона',
    'gap': 'Расстояние между элементами',
    'padding-top': 'Внутренний отступ сверху',
    'padding-right': 'Внутренний отступ справа',
    'padding-bottom': 'Внутренний отступ снизу',
    'padding-left': 'Внутренний отступ слева',
    'border-radius': 'Скругление углов',
    'flex-direction': 'Направление flexbox',
    'width': 'Ширина',
    'height': 'Высота',
    'text-content': 'Контент',
  };
  return map[prop] || prop;
}
