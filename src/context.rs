            vec!["search", "search_evidence", "api"]
        );
    }

    #[test]
    fn merges_overlapping_and_adjacent_ranges() {
        let merged = merge_ranges(vec![range(10, 20), range(21, 25), range(40, 41)]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].start, merged[0].end), (10, 25));
    }

    #[test]
    fn line_fit_never_exceeds_budget() {
        let content = "alpha\nbeta\ngamma\n";
        let (snippet, end) = fit_lines(content, 1, 3, 10).unwrap();
        assert!(snippet.len() <= 10);
        assert_eq!(end, 2);
    }
}
