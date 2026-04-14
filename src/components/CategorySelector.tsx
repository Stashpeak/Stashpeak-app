import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const inputClass =
  "glass-input-surface w-full rounded-2xl px-4 py-3 text-sm text-zinc-900 outline-none transition focus:ring-2 focus:ring-primary/10 placeholder:text-zinc-300";

type CategorySelectorProps = {
  value: string;
  categories: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  allowCreate?: boolean;
  readonlyInput?: boolean;
};

export function CategorySelector({
  value,
  categories,
  onChange,
  placeholder,
  allowCreate = true,
  readonlyInput = false,
}: CategorySelectorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [isFiltering, setIsFiltering] = useState(!readonlyInput);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({});

  const filteredCategories = useMemo(() => {
    if (!isFiltering || readonlyInput) {
      return categories;
    }

    const query = value.trim().toLowerCase();
    if (!query) {
      return categories;
    }

    return categories.filter((category) => category.toLowerCase().includes(query));
  }, [categories, isFiltering, value, readonlyInput]);

  const trimmedValue = value.trim();
  const showCreateOption =
    allowCreate &&
    !readonlyInput &&
    trimmedValue.length > 0 &&
    !filteredCategories.some((category) => category.toLowerCase() === trimmedValue.toLowerCase());

  const visibleItems = showCreateOption ? [...filteredCategories, trimmedValue] : filteredCategories;

  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const clickedTrigger = containerRef.current?.contains(target);
      const clickedDropdown = dropdownRef.current?.contains(target);

      if (!clickedTrigger && !clickedDropdown) {
        setIsOpen(false);
        setActiveIndex(-1);
        setIsFiltering(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, []);

  useEffect(() => {
    if (activeIndex >= visibleItems.length) {
      setActiveIndex(visibleItems.length - 1);
    }
  }, [activeIndex, visibleItems.length]);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;

    const activeItem = listRef.current?.children.item(activeIndex);
    if (activeItem instanceof HTMLElement) {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, isOpen]);

  useEffect(() => {
    if (!isOpen || !inputRef.current) return;

    function updateDropdownPosition() {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;

      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
      });
    }

    updateDropdownPosition();

    const observer = new ResizeObserver(updateDropdownPosition);
    observer.observe(inputRef.current);

    window.addEventListener("resize", updateDropdownPosition);
    window.addEventListener("scroll", updateDropdownPosition, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateDropdownPosition);
      window.removeEventListener("scroll", updateDropdownPosition, true);
    };
  }, [isOpen]);

  function handleSelect(category: string) {
    onChange(category);
    setIsOpen(false);
    setActiveIndex(-1);
    setIsFiltering(false);
  }

  const dropdown =
    isOpen && visibleItems.length > 0
      ? createPortal(
          <div ref={dropdownRef} className="z-[140]" style={dropdownStyle}>
            <div
              className="glass-surface-elevated overflow-hidden rounded-2xl shadow-md"
              style={{ background: "var(--bg-surface)" }}
            >
              <ul ref={listRef} className="max-h-48 overflow-y-auto py-1">
                {filteredCategories.map((category, index) => (
                  <li
                    key={category}
                    className={`cursor-pointer px-4 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 ${
                      activeIndex === index ? "bg-zinc-100" : ""
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      handleSelect(category);
                    }}
                  >
                    {category}
                  </li>
                ))}

                {showCreateOption ? (
                  <li
                    className={`cursor-pointer px-4 py-2.5 text-sm italic text-primary hover:bg-zinc-50 ${
                      activeIndex === visibleItems.length - 1 ? "bg-zinc-100" : ""
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      handleSelect(trimmedValue);
                    }}
                  >
                    Create "{trimmedValue}"
                  </li>
                ) : null}
              </ul>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div ref={containerRef} className="relative overflow-visible">
        <div className="relative">
          <input
            ref={inputRef}
            value={value}
            readOnly={readonlyInput}
            onChange={(event) => {
              if (readonlyInput) return;
              onChange(event.target.value);
              setIsOpen(true);
              setIsFiltering(true);
              setActiveIndex(-1);
            }}
            onFocus={() => {
              setIsOpen(true);
              setIsFiltering(false);
              setActiveIndex(-1);
            }}
            onClick={() => {
              if (readonlyInput && !isOpen) {
                setIsOpen(true);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (!isOpen && readonlyInput) {
                  setIsOpen(true);
                  return;
                }
                setIsOpen(true);
                setActiveIndex((prev) => {
                  if (visibleItems.length === 0) return -1;
                  return prev < visibleItems.length - 1 ? prev + 1 : 0;
                });
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setIsOpen(true);
                setActiveIndex((prev) => {
                  if (visibleItems.length === 0) return -1;
                  return prev > 0 ? prev - 1 : visibleItems.length - 1;
                });
                return;
              }

              if (event.key === "Enter" || event.key === " ") {
                if (!isOpen && readonlyInput) {
                  event.preventDefault();
                  setIsOpen(true);
                  return;
                }
                if (!isOpen) return;

                if (activeIndex >= 0 && activeIndex < visibleItems.length) {
                  event.preventDefault();
                  handleSelect(visibleItems[activeIndex]);
                } else if (readonlyInput && isOpen) {
                  event.preventDefault();
                } else {
                  setIsOpen(false);
                  setIsFiltering(false);
                }
                return;
              }

              if (event.key === "Escape") {
                setIsOpen(false);
                setActiveIndex(-1);
                setIsFiltering(false);
              }
            }}
            placeholder={placeholder}
            className={`${inputClass} ${readonlyInput ? "cursor-pointer pr-11" : ""}`}
          />
          {readonlyInput && (
            <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center">
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${isOpen ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
              </svg>
            </div>
          )}
        </div>
      </div>
      {dropdown}
    </>
  );
}
