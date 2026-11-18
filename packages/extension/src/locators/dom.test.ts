// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { elementText } from './dom';

function el(markup: string): Element {
  document.body.innerHTML = markup;
  return document.body.firstElementChild!;
}

describe('elementText: one rule for recording, checks and text locators', () => {
  it('joins adjacent text nodes without a space, as React renders `$${total}`', () => {
    const td = el('<table><tr><td></td></tr></table>').querySelector('td')!;
    td.append(document.createTextNode('$'), document.createTextNode('42'));
    expect(elementText(td)).toBe('$42');
  });

  it('keeps inline elements in the same word and separates block elements', () => {
    expect(elementText(el('<p>Total: <b>$</b><span>42</span></p>'))).toBe('Total: $42');
    expect(elementText(el('<div><div>Subtotal</div><div>$42</div></div>'))).toBe('Subtotal $42');
    expect(elementText(el('<p>one<br>two</p>'))).toBe('one two');
  });

  it('skips scripts and styles', () => {
    expect(elementText(el('<div>shown<script>hidden()</script><style>.x{}</style></div>'))).toBe('shown');
  });
});
