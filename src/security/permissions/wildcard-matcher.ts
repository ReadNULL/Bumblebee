/** 仅支持权限规则需要的 `*`、`**` 和 `?`，不解释 shell 语法。 */
export function matchesPermissionPattern(
  pattern: string,
  value: string,
  options: { readonly caseSensitive: boolean },
): boolean {
  const expression = wildcardToRegExp(pattern, options.caseSensitive);
  return expression.test(value);
}

function wildcardToRegExp(
  pattern: string,
  caseSensitive: boolean,
): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegularExpressionCharacter(character ?? "");
  }

  source += "$";
  return new RegExp(source, caseSensitive ? "u" : "iu");
}

function escapeRegularExpressionCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character)
    ? `\\${character}`
    : character;
}
