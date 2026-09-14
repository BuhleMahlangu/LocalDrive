import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Icon from './Icon.jsx';

describe('Icon', () => {
  it('renders an svg marked aria-hidden', () => {
    const { container } = render(<Icon name="home" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  });

  it('applies the size prop to width and height', () => {
    const { container } = render(<Icon name="gear" size={28} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '28');
    expect(svg).toHaveAttribute('height', '28');
  });

  it('draws different paths for different icons', () => {
    const a = render(<Icon name="car" />);
    const b = render(<Icon name="trips" />);
    // Both should have at least one path, but different content.
    expect(a.container.querySelector('path')).toBeInTheDocument();
    expect(b.container.querySelector('path')).toBeInTheDocument();
    expect(a.container.innerHTML).not.toBe(b.container.innerHTML);
  });

  it('renders an empty svg for an unknown icon', () => {
    const { container } = render(<Icon name="does-not-exist" />);
    expect(container.querySelector('svg').children.length).toBe(0);
  });
});