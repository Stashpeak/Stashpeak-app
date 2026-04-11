import { useEffect, useMemo, useRef, useState } from "react";

const inputClass =
  "w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-[#6750a4] focus:ring-2 focus:ring-[#6750a4]/10 placeholder:text-zinc-300";

type CategorySelectorProps = {
  value: string;
  categories: string[];
  onChange: (value: string) => void;
  placeholder?: string;
};

export function CategorySelector({
  value,
  categories,
  onChange,
  placeholder,
}: CategorySelectorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [isFiltering, setIsFiltering] = useState(false);

  const filteredCategories = useMemo(() => {
    if (!isFiltering) {
      return categories;
    }

    const query = value.trim().toLowerCase();

    if (!query) {
      return categories;
    }

    return categories.filter((category) => category.toLowerCase().includes(query));
  }, [categories, isFiltering, value]);

  const trimmedValue = value.trim();
  const showCreateOption =
    trimmedValue.length > 0 &&
    !filteredCategories.some((category) => category.toLowerCase() === trimmedValue.toLowerCase());

  const visibleItems = showCreateOption ? [...filteredCategories, trimmedValue] : filteredCategories;

  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
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

  function handleSelect(category: string) {
    onChange(category);
    setIsOpen(false);
    setActiveIndex(-1);
    setIsFiltering(false);
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(event) => {
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
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
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

          if (event.key === "Enter") {
            if (!isOpen) return;

            if (activeIndex >= 0 && activeIndex < visibleItems.length) {
              event.preventDefault();
              handleSelect(visibleItems[activeIndex]);
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
        className={inputClass}
      />

      {isOpen && visibleItems.length > 0 ? (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-2xl border border-zinc-200 bg-white shadow-md">
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
              className={`cursor-pointer px-4 py-2.5 text-sm italic text-[#6750a4] hover:bg-zinc-50 ${
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
      ) : null}
    </div>
  );
}
